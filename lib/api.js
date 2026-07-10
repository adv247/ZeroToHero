import { BLOCK_PAGE_ENABLED, CLOUDFLARE_WRITE_DELAY_MS, DEBUG, FAST_MODE, FAST_MODE_CONCURRENCY, LIST_COUNT_LIMIT, LIST_ITEM_SIZE } from "./constants.js";
import { requestGateway } from "./helpers.js";
import { runWithConcurrency, wait } from "./utils.js";

// Số luồng chạy song song cho các thao tác hàng loạt (fetch/patch/create/delete).
// FAST_MODE=0 -> 1 (tuần tự, y hệt hành vi gốc). FAST_MODE=1 -> FAST_MODE_CONCURRENCY.
const CONCURRENCY = FAST_MODE ? FAST_MODE_CONCURRENCY : 1;

// NGƯỠNG "THAY ĐỔI LỚN" (Smart Fallback): nếu tổng số additions+removals cần
// ghi lên Cloudflare vượt quá ngưỡng này (VD: mới thêm 1 nguồn blocklist lớn,
// tạo ra chênh lệch hàng chục nghìn dòng), việc ghi bằng concurrency cao
// (FAST_MODE) dễ dội liên tục vào giới hạn "Gateway writes" của Cloudflare,
// gây bão lỗi 429 kéo dài. Khi vượt ngưỡng, TỰ ĐỘNG ép về ghi tuần tự
// (concurrency=1) + có độ trễ chủ động giữa các lần ghi, bất kể FAST_MODE
// đang bật hay tắt - ưu tiên ổn định hơn tốc độ cho các đợt thay đổi lớn.
const LARGE_DIFF_THRESHOLD = 30_000;

const NOW_STR = new Date().toISOString();

/**
 * Gets Zero Trust lists.
 *
 * API docs: https://developers.cloudflare.com/api/operations/zero-trust-lists-list-zero-trust-lists
 * @returns {Promise<Object>}
 */
export const getZeroTrustLists = () =>
  requestGateway("/lists", {
    method: "GET",
  });

/**
 * Gets Zero Trust list items
 *
 * API docs: https://developers.cloudflare.com/api/operations/zero-trust-lists-zero-trust-list-items
 * @param {string} id The id of the list.
 * @returns {Promise<Object>}
 */
const getZeroTrustListItems = (id) =>
  requestGateway(`/lists/${id}/items?per_page=${LIST_ITEM_SIZE}`, {
    method: "GET",
  });


/**
 * Creates a Zero Trust list.
 *
 * API docs: https://developers.cloudflare.com/api/operations/zero-trust-lists-create-zero-trust-list
 * @param {string} name The name of the list.
 * @param {Object[]} items The domains/IPs in the list.
 * @param {string} items[].value The domain or IP/CIDR of an entry.
 * @param {string} [type] The Cloudflare list type: "DOMAIN" (default) or "IP".
 * @returns {Promise}
 */
const createZeroTrustList = (name, items, type = "DOMAIN") =>
  requestGateway(`/lists`, {
    method: "POST",
    body: JSON.stringify({
      name,
      type,
      items,
    }),
  });

/**
 * Patches an existing list. Remove/append entries to the list.
 *
 * API docs: https://developers.cloudflare.com/api/operations/zero-trust-lists-patch-zero-trust-list
 * @param {string} listId The ID of the list to patch
 * @param {Object} patch The changes to make
 * @param {string[]} patch.remove A list of the item values you want to remove.
 * @param {Object[]} patch.append Items to add to the list.
 * @param {string} patch.append[].value The domain of an entry.
 * @returns
 */
const patchExistingList = (listId, patch) =>
  requestGateway(`/lists/${listId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

/**
 * Synchronize Zero Trust lists.
 * Inspects existing lists starting with the given prefix (default "CGPS List")
 * Compares the entries in the lists with the desired domains in the items.
 * Removes any entries in the lists that are not in the items.
 * Adds any entries that are in the items and not in the lists.
 * Uses available capacity in existing lists prior to creating a new list.
 * @param {string[]} items The domains (or IPs/CIDRs when type is "IP").
 * @param {Object} [options]
 * @param {string} [options.prefix] The list name prefix to scope this sync to. Default "CGPS List".
 * @param {string} [options.type] The Cloudflare list type: "DOMAIN" (default) or "IP".
 */
export const synchronizeZeroTrustLists = async (items, { prefix = "CGPS List", type = "DOMAIN" } = {}) => {
  const itemSet = new Set(items);

  console.log("Checking existing lists...");
  const { result: lists } = await getZeroTrustLists();
  const cgpsLists = lists?.filter(({ name }) => name.startsWith(prefix)) || [];
  console.log(`Found ${cgpsLists.length} existing lists. Calculating diffs...`);

  const domainsByList = {};
  // Sequential by default (CONCURRENCY=1) to avoid rate-limits, or with bounded
  // concurrency when FAST_MODE=1 to speed this up significantly - fetching
  // items from every existing list is normally the slowest part of a run.
  await runWithConcurrency(cgpsLists.map(list => async () => {
    const { result: listItems, result_info } = await getZeroTrustListItems(list.id);
    if (result_info.total_count > LIST_ITEM_SIZE) {
      console.log(`List ${list.name} contains more entries that LIST_ITEM_SIZE. Checking only the first ${LIST_ITEM_SIZE} entires. You may want to delete this list and recreate using the same size limit.`);
    }
    domainsByList[list.id] = listItems?.map(item => item.value) || [];
  }), CONCURRENCY);

  // BUG THẬT ĐÃ SỬA: dọn dẹp list rỗng TRƯỚC ĐÂY được gộp bên trong vòng
  // lặp patch (chỉ chạy cho những list ĐƯỢC PATCH ở lần chạy này). Nhưng
  // 1 list có thể đã rỗng SẴN TỪ TRƯỚC (VD: nguồn thu nhỏ lại ở lần chạy
  // trước, patch đã xoá hết) - lần chạy này nếu list đó không cần xoá thêm
  // (đã rỗng, không có gì để remove) và không được chọn để lấp thêm domain
  // mới (không có trong `patches`), nó sẽ KHÔNG BAO GIỜ được kiểm tra và
  // xoá - "rác" tồn đọng vĩnh viễn, âm thầm chiếm quota 300 list. Đây chính
  // là nguyên nhân thật của "305/300" trong log bạn gửi.
  //
  // SỬA: quét ĐỘC LẬP toàn bộ `domainsByList` (đã có sẵn dữ liệu, KHÔNG cần
  // gọi thêm API) NGAY TẠI ĐÂY - trước cả khi tính diff - để bắt được MỌI
  // list rỗng, bất kể có nằm trong patches lần này hay không. Chạy trước
  // bước tính capacity còn trống (bên dưới) để quota được giải phóng SỚM
  // NHẤT, phản ánh đúng vào phép tính cắt bớt an toàn (graceful truncation).
  const staleEmptyListIds = Object.entries(domainsByList)
    .filter(([, domains]) => domains.length === 0)
    .map(([id]) => id);

  if (staleEmptyListIds.length) {
    console.warn(
      `⚠️ Phát hiện ${staleEmptyListIds.length} list "${prefix}" đã RỖNG SẴN từ trước (0 mục) - ` +
      `đang tự động xoá để giải phóng quota (không đợi tới lần patch tiếp theo)...`
    );
    await runWithConcurrency(staleEmptyListIds.map(id => async () => {
      const listName = cgpsLists.find(list => list.id === id)?.name || id;
      await deleteZeroTrustList(id);
      console.log(`Đã xoá "${listName}" - rỗng sẵn từ trước, giải phóng 1 chỗ trống.`);
      delete domainsByList[id];
    }), CONCURRENCY);
    // Loại các list vừa xoá khỏi cgpsLists để mọi phép tính phía sau (số
    // list hiện có, capacity còn trống...) phản ánh đúng trạng thái MỚI.
    cgpsLists.splice(0, cgpsLists.length, ...cgpsLists.filter(list => !staleEmptyListIds.includes(list.id)));
    if (lists) lists.splice(0, lists.length, ...lists.filter(list => !staleEmptyListIds.includes(list.id)));
  }

  // Extract all the list entries into a map, keyed by domain, pointing to the list.
  const existingDomains = Object.fromEntries(
    Object.entries(domainsByList).flatMap(([id, domains]) => domains.map(d => [d, id]))
  );

  // Create a list of entries to remove.
  // Iterate the existing list(s) removing anything that's in the new list.
  // Resulting in entries that are in the existing list(s) and not in the new list.
  const toRemove = Object.fromEntries(
    Object.entries(existingDomains).filter(([domain]) => !itemSet.has(domain))
  );

  // Create a list of entries to add.
  // Iterate the new list keeping only entries not in the existing list(s).
  // Resulting in entries that need to be added.
  const toAdd = items.filter(domain => !existingDomains[domain]);

  console.log(`${Object.keys(toRemove).length} removals, ${toAdd.length} additions to make`);

  // QUAN TRỌNG: phải lưu lại số liệu GỐC ở đây - `toAdd.length` sẽ bị giảm
  // dần ngay sau đây khi vòng lặp "lấp chỗ trống" (Fill any gaps) tiêu thụ
  // dần qua `.shift()`. Nếu tính totalDiffSize SAU vòng lặp đó, con số sẽ
  // sai (thấp hơn thực tế rất nhiều) - bug thật đã tái hiện và sửa qua test.
  const originalRemovalsCount = Object.keys(toRemove).length;
  const originalAdditionsCount = toAdd.length;

  // Group the removals by list id, so we can make a patch request.
  const removalPatches = Object.entries(toRemove).reduce((acc, [domain, listId]) => {
    acc[listId] = acc[listId] || { remove: [] };
    acc[listId].remove.push(domain);
    return acc;
  }, {});

  // Fill any "gaps" in the lists made by the removals with any additions.
  // If we can fit all the additions into the same lists that we're processing removals
  // we can minimize the number of lists that need to be edited.
  const patches = Object.fromEntries(
    Object.entries(removalPatches).map(([listId, patch]) => {
      // Work out how much "space" is in the list by looking at
      // how many entries there were and how many we're removing.
      const spaceInList = LIST_ITEM_SIZE - (domainsByList[listId].length - patch.remove.length);
      // Take upto spaceInList entries from the additions into this list.
      // Use the current timestamp as the description to track when we first see this domain.
      // This can be used to defragment the lists later and consolidate more stable entries.
      const append = Array(spaceInList)
        .fill(0)
        .map(() => toAdd.shift())
        .filter(Boolean)
        .map(domain => ({ value: domain, description: NOW_STR }));
      return [listId, { ...patch, append }];
    })
  );

  // Are there any more appends remaining?
  if (toAdd.length) {
    // Is there any space in any existing lists, other than those we're already patching?
    const unpatchedListIds = Object.keys(domainsByList).filter(listId => !patches[listId]);
    unpatchedListIds.forEach(listId => {
      const spaceInList = LIST_ITEM_SIZE - domainsByList[listId].length;
      if (spaceInList > 0) {
        // Take upto spaceInList entries from the additions into this list.
        const append = Array(spaceInList)
          .fill(0)
          .map(() => toAdd.shift())
          .filter(Boolean)
          .map(domain => ({ value: domain, description: NOW_STR }));

        // Add this list edit to the patches
        if (append.length) {
          patches[listId] = { append };
        }
      }
    });
  }

  // NGƯỠNG THAY ĐỔI LỚN: nếu tổng additions+removals vượt LARGE_DIFF_THRESHOLD
  // (VD: vừa thêm 1 nguồn blocklist mới, tạo ra chênh lệch hàng chục nghìn
  // dòng), ép về ghi TUẦN TỰ (concurrency=1) bất kể FAST_MODE, để tránh dội
  // liên tục vào giới hạn "Gateway writes" của Cloudflare (đây chính là
  // nguyên nhân gây bão lỗi 429 khi thêm nguồn mới - xác nhận qua log thật).
  const totalDiffSize = originalRemovalsCount + originalAdditionsCount;
  const isLargeDiff = totalDiffSize > LARGE_DIFF_THRESHOLD;
  const writeConcurrency = isLargeDiff ? 1 : CONCURRENCY;
  if (isLargeDiff) {
    console.warn(
      `⚠️ Thay đổi LỚN phát hiện: ${totalDiffSize.toLocaleString()} additions+removals ` +
      `(vượt ngưỡng ${LARGE_DIFF_THRESHOLD.toLocaleString()}) - tự động chuyển sang ghi TUẦN TỰ ` +
      `(bất kể FAST_MODE) kèm độ trễ ${CLOUDFLARE_WRITE_DELAY_MS}ms/lần để tránh bão lỗi 429. ` +
      `Lần chạy này sẽ chậm hơn bình thường - đây là đánh đổi có chủ đích để ưu tiên ổn định.`
    );
  }

  // Process all the patches. Sequential by default, or with bounded
  // concurrency when FAST_MODE=1 - trừ khi thay đổi quá lớn (xem trên), luôn
  // ép tuần tự. Sau MỖI lần ghi thành công, đợi thêm CLOUDFLARE_WRITE_DELAY_MS
  // (độ trễ chủ động) để tránh dồn dập chạm rate-limit "Gateway writes" ngay
  // từ đầu, thay vì chỉ dựa vào cơ chế backoff phản ứng sau khi đã bị 429.
  await runWithConcurrency(Object.entries(patches).map(([listId, patch]) => async () => {
    const appends = !!patch.append ? patch.append.length : 0;
    const removals = !!patch.remove ? patch.remove.length : 0;
    console.log(`Updating list "${cgpsLists.find(list => list.id === listId).name}"${appends ? `, ${appends} additions` : ''}${removals ? `, ${removals} removals` : ''}`);
    await patchExistingList(listId, patch);

    // TỰ ĐỘNG DỌN DẸP: nếu patch này xoá hết mọi domain/IP của list mà không
    // thêm gì bù vào (list rỗng sau patch), xoá luôn list đó ngay lập tức -
    // thay vì đợi tới lần chạy defragment-lists.yml hàng tuần. List rỗng vẫn
    // tính vào giới hạn 300 list/tài khoản dù không còn dữ liệu gì, nên dọn
    // ngay giúp giải phóng quota sớm hơn.
    const originalSize = domainsByList[listId].length;
    const finalSize = originalSize - removals + appends;
    if (finalSize === 0) {
      const listName = cgpsLists.find(list => list.id === listId).name;
      await deleteZeroTrustList(listId);
      console.log(`Đã xoá "${listName}" - rỗng sau khi cập nhật, giải phóng 1 chỗ trống trong giới hạn 300 list.`);
    }

    if (CLOUDFLARE_WRITE_DELAY_MS > 0) await wait(CLOUDFLARE_WRITE_DELAY_MS);
  }), writeConcurrency);

  // Are there any more appends remaining?
  let createdListsCount = 0;
  let truncatedCount = 0;
  if (toAdd.length) {
    // We'll need to create new list(s)
    const chunkPrefix = `${prefix} - Chunk `;
    const nextListNumber = Math.max(0, ...cgpsLists.map(list => parseInt(list.name.replace(chunkPrefix, ''))).filter(x => Number.isInteger(x))) + 1;

    // CẮT BỚT AN TOÀN (Graceful Truncation) - ĐÃ NÂNG CẤP: trước đây chỉ in
    // cảnh báo rồi vẫn cố tạo hết, để Cloudflare tự chối bằng lỗi 400 giữa
    // chừng khi đầy. Giờ áp dụng ĐÚNG cùng triết lý với giới hạn 300.000
    // domain (đã có sẵn ở cf_list_create.js): tính trước dung lượng thật sự
    // còn trống trong giới hạn LIST_COUNT_LIMIT list/tài khoản (mặc định 300,
    // cấu hình được qua secret CLOUDFLARE_LIST_COUNT_LIMIT cho gói Enterprise
    // có hạn mức cao hơn), chỉ tạo đúng số lượng vừa đủ, KHÔNG BAO GIỜ gọi
    // API vượt quá giới hạn thật - loại bỏ hoàn toàn khả năng dính lỗi 400
    // "Maximum number of lists reached" ở bước này.
    const remainingListCapacity = Math.max(0, LIST_COUNT_LIMIT - (lists?.length || 0));
    const maxNewItems = remainingListCapacity * LIST_ITEM_SIZE;

    if (toAdd.length > maxNewItems) {
      truncatedCount = toAdd.length - maxNewItems;
      console.warn(
        `⚠️ ĐÃ CHẠM GIỚI HẠN ${LIST_COUNT_LIMIT} LIST/TÀI KHOẢN: tài khoản hiện có ${lists?.length || 0} list, chỉ còn ` +
        `${remainingListCapacity} chỗ trống (tối đa ${maxNewItems.toLocaleString()} mục mới) cho "${prefix}". ` +
        `${truncatedCount.toLocaleString()} mục KHÔNG được thêm vào lần này (bị cắt bớt an toàn) - KHÔNG phải lỗi, ` +
        `script vẫn hoàn tất bình thường với phần dữ liệu vừa đủ giới hạn. Muốn thêm đủ: chạy defragment-lists.yml ` +
        `để dọn list rỗng/gọn lại, giảm bớt nguồn dữ liệu, hoặc nếu tài khoản bạn thực sự có hạn mức cao hơn ` +
        `${LIST_COUNT_LIMIT}, đặt secret CLOUDFLARE_LIST_COUNT_LIMIT cho đúng.`
      );
      toAdd.length = maxNewItems;
    }

    if (toAdd.length) {
      createdListsCount = Math.ceil(toAdd.length / LIST_ITEM_SIZE);
      await createZeroTrustListsOneByOne(toAdd, nextListNumber, { prefix, type, concurrency: writeConcurrency });
    }
  }

  return {
    totalItems: items.length,
    existingListsCount: cgpsLists.length,
    patchedListsCount: Object.keys(patches).length,
    createdListsCount,
    currentListsCount: cgpsLists.length + createdListsCount,
    truncatedCount,
  };
};

/**
 * Defragment Zero Trust lists.
 * Inspects existing lists starting with "<prefix> - Chunk <number>"
 * Sorts the entries by the description which may include a timestamp.
 * Unfortunately the API does not allow setting the created_at time for the entries.
 * Rewrites the lists in order of the entry creation such that older
 * domains are in the earlier lists. Older domains implies the domain is
 * a more stable entry, so we're less likely to need to patch this list often.
 * So we can reduce the number of lists we need to patch for updates and isolate
 * the churn to the last list or few lists.
 * @param {Object} [options]
 * @param {string} [options.prefix] The list name prefix. Default "CGPS List".
 * @returns {Promise<Object>} A object that include the now empty and non-empty lists
 */
export const defragmentZeroTrustLists = async ({ prefix = "CGPS List" } = {}) => {
  const chunkPrefix = `${prefix} - Chunk `;
  console.log("Checking existing lists...");
  const { result: lists } = await getZeroTrustLists();
  const cgpsLists = lists?.filter(({ name }) => name.startsWith(chunkPrefix)) || [];
  console.log(`Found ${cgpsLists.length} existing lists. Downloading...`);

  // Sort the lists by the natural number order in the name
  cgpsLists.sort((a, b) => {
    const aNum = parseInt(a.name.replace(chunkPrefix, ""));
    const bNum = parseInt(b.name.replace(chunkPrefix, ""));
    return aNum - bNum;
  });

  const allEntries = [];
  // Fetch all the items in the lists. Sequential by default, or with bounded
  // concurrency when FAST_MODE=1.
  await runWithConcurrency(cgpsLists.map(list => async () => {
    const { result: listItems } = await getZeroTrustListItems(list.id);
    // Annotate the items with the list id that they came from so we know what to patch later
    // Ensure the description is a valid timestamp, or set it to the current time.
    // We use the description as the list addition time because the API does not allow setting the created_at time.
    const itemsWithOriginListId = listItems?.map(item => ({
      ...item,
      originListId: list.id,
      description: isNaN(new Date(item.description)) ? NOW_STR : item.description,
    })) || [];
    allEntries.push(...itemsWithOriginListId);
  }), CONCURRENCY);

  console.log(`Found ${allEntries.length} entries in ${cgpsLists.length} lists`);

  // Sort the entries by the time stored in the description.
  // For conflict resolution use the domain name as a tiebreaker.
  // This is important to avoid flip-flopping entries between lists
  // in subsequent runs.
  allEntries.sort((a, b) => {
    const createdAtA = new Date(a.description);
    const createdAtB = new Date(b.description);
    if (createdAtA.getTime() === createdAtB.getTime()) {
      return a.value.localeCompare(b.value);
    }
    return createdAtA - createdAtB;
  });

  // Assign the entries to lists in order of the created_at time
  const assignedEntries = allEntries.map((entry, index) => {
    const listIndex = Math.floor(index / LIST_ITEM_SIZE);
    const assignedListId = cgpsLists[listIndex]?.id || null;
    // The list should always exist since we're only shuffling the entries
    if (!assignedListId) {
      throw new Error(`Unable to resolve list for entry ${index}, have only ${cgpsLists.length} lists`);
    }
    return { ...entry, assignedListId };
  });

  // Filter down to the entries that are changing assigned lists
  const entriesToMove = assignedEntries.filter(entry => entry.originListId !== entry.assignedListId);

  // Create the patches per list
  const patches = {};
  for (const entry of entriesToMove) {
    const { originListId, assignedListId, ...gatewayItem } = entry;
    if (!patches[originListId]) {
      patches[originListId] = { append: [], remove: [] };
    }
    // Remove by value
    patches[originListId].remove.push(gatewayItem.value);

    if (!patches[assignedListId]) {
      patches[assignedListId] = { append: [], remove: [] };
    }
    // Append by GatewayItem which has value, description and created_at properties
    patches[assignedListId].append.push(gatewayItem);
  }

  console.log(`Found ${Object.keys(patches).length} patches to make, moving ${entriesToMove.length} entries...`);

  // Process all the patches. Sequential by default, or with bounded
  // concurrency when FAST_MODE=1.
  await runWithConcurrency(Object.entries(patches).map(([listId, patch]) => async () => {
    const appends = !!patch.append ? patch.append.length : 0;
    const removals = !!patch.remove ? patch.remove.length : 0;
    console.log(`Updating list "${cgpsLists.find(list => list.id === listId).name}"${appends ? `, ${appends} additions` : ''}${removals ? `, ${removals} removals` : ''}`);
    await patchExistingList(listId, patch);
  }), CONCURRENCY);

  // Did we leave any lists empty?
  // We can tell by checking that the list ids are used in the assignedEntries
  const assignedLists = new Set();
  assignedEntries.forEach(entry => assignedLists.add(entry.assignedListId));
  // Filter the lists down to those that are empty
  const emptyLists = cgpsLists.filter(list => !assignedLists.has(list.id));
  // Gather the non-empty lists, using the original list not just the chunked ones
  // This is important to capture any manually created lists starting with the
  // same prefix, and not just the ones created by this script. Scoped to
  // `prefix` so defragmenting domain lists never pulls in IP lists (or vice versa).
  const nonEmptyLists = lists.filter(list => list.name.startsWith(prefix) && !emptyLists.some(emptyList => emptyList.id === list.id));

  return {
    emptyLists,
    nonEmptyLists,
    stats: {
      assignedLists: assignedLists.size,
      emptyLists: emptyLists.length,
      nonEmptyLists: nonEmptyLists.length,
      entriesToMove: entriesToMove.length,
      patches: Object.keys(patches).length,
      allEntries: allEntries.length,
      chunks: cgpsLists.length,
    }
  };
}

/**
 * Creates Zero Trust lists sequentially (or concurrently under FAST_MODE).
 * @param {string[]} items The domains (or IPs/CIDRs when type is "IP").
 * @param {Number} [startingListNumber] The chunk number to start from when naming lists.
 * @param {Object} [options]
 * @param {string} [options.prefix] The list name prefix. Default "CGPS List".
 * @param {string} [options.type] The Cloudflare list type: "DOMAIN" (default) or "IP".
 */
export const createZeroTrustListsOneByOne = async (items, startingListNumber = 1, { prefix = "CGPS List", type = "DOMAIN", concurrency = CONCURRENCY } = {}) => {
  const totalChunks = Math.ceil(items.length / LIST_ITEM_SIZE);
  let remaining = totalChunks;

  // Build one task per chunk. listNumber is derived from the chunk index
  // (not a shared mutable counter) so this is safe to run concurrently.
  const tasks = [];
  for (let i = 0, chunkIndex = 0; i < items.length; i += LIST_ITEM_SIZE, chunkIndex++) {
    const listNumber = startingListNumber + chunkIndex;
    // We use the description as the list addition time because the API does not allow setting the created_at time.
    const chunk = items
      .slice(i, i + LIST_ITEM_SIZE)
      .map((item) => ({ value: item, description: NOW_STR }));
    const listName = `${prefix} - Chunk ${listNumber}`;

    tasks.push(async () => {
      try {
        await createZeroTrustList(listName, chunk, type);
        remaining--;
        console.log(`Created "${listName}" list - ${remaining} left`);
        // Độ trễ chủ động sau MỖI lần tạo thành công - xem giải thích chi
        // tiết ở synchronizeZeroTrustLists (cùng lý do: tránh dội liên tục
        // vào giới hạn "Gateway writes" của Cloudflare khi tạo hàng loạt list).
        if (CLOUDFLARE_WRITE_DELAY_MS > 0) await wait(CLOUDFLARE_WRITE_DELAY_MS);
      } catch (err) {
        console.error(`Could not create "${listName}" - ${err.toString()}`);
        throw err;
      }
    });
  }

  // Sequential by default, hoặc concurrency giới hạn khi FAST_MODE=1 - trừ
  // khi caller (VD: synchronizeZeroTrustLists khi phát hiện thay đổi lớn)
  // truyền vào concurrency=1 để ép tuần tự bất kể FAST_MODE.
  await runWithConcurrency(tasks, concurrency);
};

/**
 * Deletes a Zero Trust list.
 *
 * API docs: https://developers.cloudflare.com/api/operations/zero-trust-lists-delete-zero-trust-list
 * @param {number} id The ID of the list.
 * @returns {Promise<any>}
 */
const deleteZeroTrustList = (id) =>
  requestGateway(`/lists/${id}`, { method: "DELETE" });

/**
 * Deletes Zero Trust lists sequentially.
 * @param {Object[]} lists The lists to be deleted.
 * @param {number} lists[].id The ID of a list.
 * @param {string} lists[].name The name of a list.
 */
export const deleteZeroTrustListsOneByOne = async (lists) => {
  let remaining = lists.length;

  const tasks = lists.map(({ id, name }) => async () => {
    try {
      await deleteZeroTrustList(id);
      remaining--;
      console.log(`Deleted ${name} list - ${remaining} left`);
    } catch (err) {
      console.error(`Could not delete ${name} - ${err.toString()}`);
      throw err;
    }
  });

  // Sequential by default, or with bounded concurrency when FAST_MODE=1.
  await runWithConcurrency(tasks, CONCURRENCY);
};

/**
 * Gets Zero Trust rules.
 *
 * API docs: https://developers.cloudflare.com/api/operations/zero-trust-gateway-rules-list-zero-trust-gateway-rules
 * @returns {Promise<Object>}
 */
export const getZeroTrustRules = () =>
  requestGateway("/rules", { method: "GET" });

/**
 * Upserts a Zero Trust rule.
 * If a rule with the same name exists, will update it. Otherwise create a new rule.
 * @param {string} wirefilterExpression The expression to be used for the rule.
 * @param {string} name The name of the rule.
 * @param {string[]} filters The filters to be used for the rule. Default is ["dns"]. Possible values are ["dns", "http", "l4", "egress"].
 * @returns {Promise<Object>}
 */
export const upsertZeroTrustRule = async (wirefilterExpression, name = "CGPS Filter Lists", filters = ["dns"]) => {
  const { result: existingRules} = await getZeroTrustRules();
  const existingRule = existingRules.find(rule => rule.name === name);
  if (existingRule) {
    if (DEBUG) console.log(`Found "${existingRule.name}" in rules, updating...`);
    return updateZeroTrustRule(existingRule.id, wirefilterExpression, name, filters);
  }
  if (DEBUG) console.log(`No existing rule named "${existingRule.name}", creating...`);
  return createZeroTrustRule(wirefilterExpression, name, filters);
}

/**
 * Creates a Zero Trust rule.
 *
 * API docs: https://developers.cloudflare.com/api/operations/zero-trust-gateway-rules-create-zero-trust-gateway-rule
 * @param {string} wirefilterExpression The expression to be used for the rule.
 * @param {string} name The name of the rule.
 * @param {string[]} filters The filters to be used for the rule. Default is ["dns"]. Possible values are ["dns", "http", "l4", "egress"].
 * @returns {Promise<Object>}
 */
export const createZeroTrustRule = async (wirefilterExpression, name = "CGPS Filter Lists", filters = ["dns"]) => {
  try {
    await requestGateway("/rules", {
      method: "POST",
      body: JSON.stringify({
        name,
        description:
          "Filter lists created by Cloudflare Gateway Pi-hole Scripts. Avoid editing this rule. Changing the name of this rule will break the script.",
        enabled: true,
        action: "block",
        rule_settings: { "block_page_enabled": BLOCK_PAGE_ENABLED, "block_reason": "Blocked by CGPS, check your filter lists if this was a mistake." },
        filters,
        traffic: wirefilterExpression,
      }),
    });

    console.log("Created rule successfully");
  } catch (err) {
    console.error(`Error occurred while creating rule - ${err.toString()}`);
    throw err;
  }
};

/**
 * Updates a Zero Trust rule.
 *
 * API docs: https://developers.cloudflare.com/api/operations/zero-trust-gateway-rules-update-zero-trust-gateway-rule
 * @param {number} id The ID of the rule to be updated.
 * @param {string} wirefilterExpression The expression to be used for the rule.
 * @param {string} name The name of the rule.
 * @param {string[]} filters The filters to be used for the rule.
 * @returns {Promise<Object>}
 */
export const updateZeroTrustRule = async (id, wirefilterExpression, name = "CGPS Filter Lists", filters = ["dns"]) => {
  try {
    await requestGateway(`/rules/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        // Name and action are required fields, even if they haven't changed.
        // And enabled must always be set to true, otherwise the rule will be disabled if omitted.
        name,
        description:
          "Filter lists created by Cloudflare Gateway Pi-hole Scripts. Avoid editing this rule. Changing the name of this rule will break the script.",
        action: "block",
        enabled: true,
        rule_settings: { "block_page_enabled": BLOCK_PAGE_ENABLED, "block_reason": "Blocked by CGPS, check your filter lists if this was a mistake." },
        filters,
        traffic: wirefilterExpression,
      }),
    });

    console.log("Updated existing rule successfully");
  } catch (err) {
    console.error(`Error occurred while updating rule - ${err.toString()}`);
    throw err;
  }
};

/**
 * Deletes a Zero Trust rule.
 *
 * API docs: https://developers.cloudflare.com/api/operations/zero-trust-gateway-rules-delete-zero-trust-gateway-rule
 * @param {number} id The ID of the rule to be deleted.
 * @returns {Promise<Object>}
 */
export const deleteZeroTrustRule = async (id) => {
  try {
    await requestGateway(`/rules/${id}`, {
      method: "DELETE",
    });

    console.log("Deleted rule successfully");
  } catch (err) {
    console.error(`Error occurred while deleting rule - ${err.toString()}`);
    throw err;
  }
};

/**
 * Creates or Updates Zero Trust Network policy for a given array of IP lists.
 * Blocks traffic whose destination IP matches any entry in the lists.
 * Uses a Gateway Network policy (filter "l4", selector net.dst.ip), which is
 * part of the standard Zero Trust Gateway product - NOT the separate,
 * Enterprise-only "Cloudflare Network Firewall" packet-filtering product.
 * @param {object[]} lists The IP lists to be used for the rule.
 * @param {string} lists[].id The ID of the list.
 * @param {string} lists[].name The name of the list.
 * @param {string} listName The name of the rule.
 */
export const upsertZeroTrustIPRule = async (lists, listName) => {
  // Create a Wirefilter expression to match destination IPs against all the IP lists
  const wirefilterIPExpression = lists
    .filter(({ name }) => name.startsWith("CGPS IP List"))
    .map(({ id }) => `net.dst.ip in \$${id}`)
    .join(" or ");
  console.log("Checking Network (IP) rule...");
  await upsertZeroTrustRule(wirefilterIPExpression, listName, ["l4"]);
};

/**
 * Creates or Updates Zero Trust DNS rule for a given array of lists.
 * @param {object[]} lists The lists to be used for the rule.
 * @param {string} lists[].id The ID of the list.
 * @param {string} lists[].name The name of the list.
 * @param {string} listName The name of the list.
 */
export const upsertZeroTrustDNSRule = async (lists, listName) => {
  // Create a Wirefilter expression to match DNS queries against all the lists
  const wirefilterDNSExpression = lists
    .filter(({ name }) => name.startsWith("CGPS List"))
    .map(({ id }) => `any(dns.domains[*] in \$${id})`)
    .join(" or ");
  console.log("Checking DNS rule...");
  await upsertZeroTrustRule(wirefilterDNSExpression, listName, ["dns"]);
};

/**
 * Creates or Updates Zero Trust SNI rule for a given array of lists.
 * @param {object[]} lists The lists to be used for the rule.
 * @param {string} lists[].id The ID of the list.
 * @param {string} lists[].name The name of the list.
 * @param {string} listName The name of the list.
 */
export const upsertZeroTrustSNIRule = async (lists, listName) => {
  // Create a Wirefilter expression to match SNI queries against all the lists
  const wirefilterSNIExpression = lists
    .filter(({ name }) => name.startsWith("CGPS List"))
    .map(({ id }) => `any(net.sni.domains[*] in \$${id})`)
    .join(" or ");
  console.log("Creating SNI rule...");
  await upsertZeroTrustRule(wirefilterSNIExpression, listName, ["l4"]);
};
