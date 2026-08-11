import { BLOCK_PAGE_ENABLED, CLOUDFLARE_WRITE_DELAY_MS, DEBUG, FAST_MODE, FAST_MODE_CONCURRENCY, LIST_COUNT_LIMIT, LIST_ITEM_SIZE } from "./constants.js";
import { requestGateway } from "./helpers.js";
import { runWithConcurrency, wait } from "./utils.js";

const CONCURRENCY = FAST_MODE ? FAST_MODE_CONCURRENCY : 1;
const LARGE_DIFF_THRESHOLD = 30_000;
const NOW_STR = new Date().toISOString();

export const getZeroTrustLists = () =>
  requestGateway("/lists", { method: "GET" });

const getZeroTrustListItems = (id) =>
  requestGateway(`/lists/${id}/items?per_page=${LIST_ITEM_SIZE}`, { method: "GET" });

const createZeroTrustList = (name, items, type = "DOMAIN") =>
  requestGateway(`/lists`, {
    method: "POST",
    body: JSON.stringify({ name, type, items }),
  });

const patchExistingList = (listId, patch) =>
  requestGateway(`/lists/${listId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

export const synchronizeZeroTrustLists = async (items, { prefix = "CGPS List", type = "DOMAIN" } = {}) => {
  const itemSet = new Set(items);

  console.log("Checking existing lists...");
  const { result: lists } = await getZeroTrustLists();
  const cgpsLists = lists?.filter(({ name }) => name.startsWith(prefix)) || [];
  console.log(`Found ${cgpsLists.length} existing lists. Calculating diffs...`);

  const domainsByList = {};
  await runWithConcurrency(cgpsLists.map(list => async () => {
    const { result: listItems, result_info } = await getZeroTrustListItems(list.id);
    if (result_info.total_count > LIST_ITEM_SIZE) {
      console.log(`List ${list.name} contains more entries that LIST_ITEM_SIZE. Checking only the first ${LIST_ITEM_SIZE} entires. You may want to delete this list and recreate using the same size limit.`);
    }
    domainsByList[list.id] = listItems?.map(item => item.value) || [];
  }), CONCURRENCY);

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
      try {
        await deleteZeroTrustList(id);
        console.log(`Đã xoá "${listName}" - rỗng sẵn từ trước, giải phóng 1 chỗ trống.`);
        delete domainsByList[id];
      } catch (err) {
        if (isListInUsePolicyError(err)) {
          console.warn(`⚠️ Bỏ qua xóa list "${listName}" do đang bám vào Policy (List is in use at gateway policies).`);
        } else {
          throw err;
        }
      }
    }), CONCURRENCY);
    const stillEmptyIds = staleEmptyListIds.filter(id => domainsByList[id] !== undefined);
    cgpsLists.splice(0, cgpsLists.length, ...cgpsLists.filter(list => !staleEmptyListIds.includes(list.id) || stillEmptyIds.includes(list.id)));
    if (lists) lists.splice(0, lists.length, ...lists.filter(list => !staleEmptyListIds.includes(list.id) || stillEmptyIds.includes(list.id)));
  }

  const existingDomains = Object.fromEntries(
    Object.entries(domainsByList).flatMap(([id, domains]) => domains.map(d => [d, id]))
  );

  const toRemove = Object.fromEntries(
    Object.entries(existingDomains).filter(([domain]) => !itemSet.has(domain))
  );

  const toAdd = items.filter(domain => !existingDomains[domain]);

  console.log(`${Object.keys(toRemove).length} removals, ${toAdd.length} additions to make`);

  const originalRemovalsCount = Object.keys(toRemove).length;
  const originalAdditionsCount = toAdd.length;

  const removalPatches = Object.entries(toRemove).reduce((acc, [domain, listId]) => {
    acc[listId] = acc[listId] || { remove: [] };
    acc[listId].remove.push(domain);
    return acc;
  }, {});

  const patches = Object.fromEntries(
    Object.entries(removalPatches).map(([listId, patch]) => {
      const spaceInList = LIST_ITEM_SIZE - (domainsByList[listId].length - patch.remove.length);
      const append = Array(spaceInList)
        .fill(0)
        .map(() => toAdd.shift())
        .filter(Boolean)
        .map(domain => ({ value: domain, description: NOW_STR }));
      return [listId, { ...patch, append }];
    })
  );

  if (toAdd.length) {
    const unpatchedListIds = Object.keys(domainsByList).filter(listId => !patches[listId]);
    unpatchedListIds.forEach(listId => {
      const spaceInList = LIST_ITEM_SIZE - domainsByList[listId].length;
      if (spaceInList > 0) {
        const append = Array(spaceInList)
          .fill(0)
          .map(() => toAdd.shift())
          .filter(Boolean)
          .map(domain => ({ value: domain, description: NOW_STR }));

        if (append.length) {
          patches[listId] = { append };
        }
      }
    });
  }

  const totalDiffSize = originalRemovalsCount + originalAdditionsCount;
  const isLargeDiff = totalDiffSize > LARGE_DIFF_THRESHOLD;
  const writeConcurrency = isLargeDiff ? 1 : CONCURRENCY;
  if (isLargeDiff) {
    console.warn(
      `⚠️ Thay đổi LỚN phát hiện: ${totalDiffSize.toLocaleString()} additions+removals ` +
      `(vượt ngưỡng ${LARGE_DIFF_THRESHOLD.toLocaleString()}) - tự động chuyển sang ghi TUẦN TỰ ` +
      `(bất kể FAST_MODE) kèm độ trễ ${CLOUDFLARE_WRITE_DELAY_MS}ms/lần để tránh bão lỗi 429.`
    );
  }

  let skippedInUseCount = 0;
  await runWithConcurrency(Object.entries(patches).map(([listId, patch]) => async () => {
    const appends = !!patch.append ? patch.append.length : 0;
    const removals = !!patch.remove ? patch.remove.length : 0;
    console.log(`Updating list "${cgpsLists.find(list => list.id === listId).name}"${appends ? `, ${appends} additions` : ''}${removals ? `, ${removals} removals` : ''}`);
    await patchExistingList(listId, patch);

    const originalSize = domainsByList[listId].length;
    const finalSize = originalSize - removals + appends;
    if (finalSize === 0) {
      const listName = cgpsLists.find(list => list.id === listId).name;
      try {
        await deleteZeroTrustList(listId);
        console.log(`Đã xoá "${listName}" - rỗng sau khi cập nhật, giải phóng 1 chỗ trống trong giới hạn 300 list.`);
      } catch (err) {
        if (isListInUsePolicyError(err)) {
          skippedInUseCount++;
          console.warn(`⚠️ Bỏ qua xóa list "${listName}" do đang bám vào Policy (List is in use at gateway policies).`);
        } else {
          throw err;
        }
      }
    }
    if (CLOUDFLARE_WRITE_DELAY_MS > 0) await wait(CLOUDFLARE_WRITE_DELAY_MS);
  }), writeConcurrency);

  let createdListsCount = 0;
  let truncatedCount = 0;
  if (toAdd.length) {
    const chunkPrefix = `${prefix} - Chunk `;
    const nextListNumber = Math.max(0, ...cgpsLists.map(list => parseInt(list.name.replace(chunkPrefix, ''))).filter(x => Number.isInteger(x))) + 1;

    const remainingListCapacity = Math.max(0, LIST_COUNT_LIMIT - (lists?.length || 0));
    const maxNewItems = remainingListCapacity * LIST_ITEM_SIZE;

    if (toAdd.length > maxNewItems) {
      truncatedCount = toAdd.length - maxNewItems;
      console.warn(
        `⚠️ ĐÃ CHẠM GIỚI HẠN ${LIST_COUNT_LIMIT} LIST/TÀI KHOẢN: tài khoản hiện có ${lists?.length || 0} list, chỉ còn ` +
        `${remainingListCapacity} chỗ trống (tối đa ${maxNewItems.toLocaleString()} mục mới) cho "${prefix}". ` +
        `${truncatedCount.toLocaleString()} mục KHÔNG được thêm vào lần này (bị cắt bớt an toàn) - KHÔNG phải lỗi. ` +
        `Chạy defragment-lists.yml để dọn dẹp, hoặc đặt secret CLOUDFLARE_LIST_COUNT_LIMIT nếu tài khoản có hạn mức cao hơn.`
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
    skippedInUseCount,
  };
};

export const defragmentZeroTrustLists = async ({ prefix = "CGPS List" } = {}) => {
  const chunkPrefix = `${prefix} - Chunk `;
  console.log("Checking existing lists...");
  const { result: lists } = await getZeroTrustLists();
  const cgpsLists = lists?.filter(({ name }) => name.startsWith(chunkPrefix)) || [];
  console.log(`Found ${cgpsLists.length} existing lists. Downloading...`);

  cgpsLists.sort((a, b) => {
    const aNum = parseInt(a.name.replace(chunkPrefix, ""));
    const bNum = parseInt(b.name.replace(chunkPrefix, ""));
    return aNum - bNum;
  });

  const allEntries = [];
  await runWithConcurrency(cgpsLists.map(list => async () => {
    const { result: listItems } = await getZeroTrustListItems(list.id);
    const itemsWithOriginListId = listItems?.map(item => ({
      ...item,
      originListId: list.id,
      description: isNaN(new Date(item.description)) ? NOW_STR : item.description,
    })) || [];
    allEntries.push(...itemsWithOriginListId);
  }), CONCURRENCY);

  console.log(`Found ${allEntries.length} entries in ${cgpsLists.length} lists`);

  allEntries.sort((a, b) => {
    const createdAtA = new Date(a.description);
    const createdAtB = new Date(b.description);
    if (createdAtA.getTime() === createdAtB.getTime()) {
      return a.value.localeCompare(b.value);
    }
    return createdAtA - createdAtB;
  });

  const assignedEntries = allEntries.map((entry, index) => {
    const listIndex = Math.floor(index / LIST_ITEM_SIZE);
    const assignedListId = cgpsLists[listIndex]?.id || null;
    if (!assignedListId) {
      throw new Error(`Unable to resolve list for entry ${index}, have only ${cgpsLists.length} lists`);
    }
    return { ...entry, assignedListId };
  });

  const entriesToMove = assignedEntries.filter(entry => entry.originListId !== entry.assignedListId);

  const patches = {};
  for (const entry of entriesToMove) {
    const { originListId, assignedListId, ...gatewayItem } = entry;
    if (!patches[originListId]) {
      patches[originListId] = { append: [], remove: [] };
    }
    patches[originListId].remove.push(gatewayItem.value);

    if (!patches[assignedListId]) {
      patches[assignedListId] = { append: [], remove: [] };
    }
    patches[assignedListId].append.push(gatewayItem);
  }

  console.log(`Found ${Object.keys(patches).length} patches to make, moving ${entriesToMove.length} entries...`);

  await runWithConcurrency(Object.entries(patches).map(([listId, patch]) => async () => {
    const appends = !!patch.append ? patch.append.length : 0;
    const removals = !!patch.remove ? patch.remove.length : 0;
    console.log(`Updating list "${cgpsLists.find(list => list.id === listId).name}"${appends ? `, ${appends} additions` : ''}${removals ? `, ${removals} removals` : ''}`);
    await patchExistingList(listId, patch);
  }), CONCURRENCY);

  const assignedLists = new Set();
  assignedEntries.forEach(entry => assignedLists.add(entry.assignedListId));
  const emptyLists = cgpsLists.filter(list => !assignedLists.has(list.id));
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
    },
  };
};

export const createZeroTrustListsOneByOne = async (items, startingListNumber = 1, { prefix = "CGPS List", type = "DOMAIN", concurrency = CONCURRENCY } = {}) => {
  const totalChunks = Math.ceil(items.length / LIST_ITEM_SIZE);
  let remaining = totalChunks;

  const tasks = [];
  for (let i = 0, chunkIndex = 0; i < items.length; i += LIST_ITEM_SIZE, chunkIndex++) {
    const listNumber = startingListNumber + chunkIndex;
    const chunk = items
      .slice(i, i + LIST_ITEM_SIZE)
      .map((item) => ({ value: item, description: NOW_STR }));
    const listName = `${prefix} - Chunk ${listNumber}`;

    tasks.push(async () => {
      try {
        await createZeroTrustList(listName, chunk, type);
        remaining--;
        console.log(`Created "${listName}" list - ${remaining} left`);
        if (CLOUDFLARE_WRITE_DELAY_MS > 0) await wait(CLOUDFLARE_WRITE_DELAY_MS);
      } catch (err) {
        console.error(`Could not create "${listName}" - ${err.toString()}`);
        throw err;
      }
    });
  }

  await runWithConcurrency(tasks, concurrency);
};

const isListInUsePolicyError = (err) => {
  const message = err?.message || err?.toString() || "";
  return /list is in use|in use at gateway polic/i.test(message);
};

const deleteZeroTrustList = (id) =>
  requestGateway(`/lists/${id}`, { method: "DELETE" });

export const deleteZeroTrustListsOneByOne = async (lists) => {
  let remaining = lists.length;
  let deletedCount = 0;
  let skippedInUseCount = 0;

  const tasks = lists.map(({ id, name }) => async () => {
    try {
      await deleteZeroTrustList(id);
      remaining--;
      deletedCount++;
      console.log(`Deleted ${name} list - ${remaining} left`);
    } catch (err) {
      if (isListInUsePolicyError(err)) {
        remaining--;
        skippedInUseCount++;
        console.warn(`⚠️ Bỏ qua xóa list "${name}" do đang bám vào Policy (List is in use at gateway policies) - ${remaining} left`);
        return;
      }
      console.error(`Could not delete ${name} - ${err.toString()}`);
      throw err;
    }
  });

  await runWithConcurrency(tasks, CONCURRENCY);

  if (skippedInUseCount > 0) {
    console.warn(
      `⚠️ Tổng cộng đã bỏ qua ${skippedInUseCount} list vẫn đang bám vào Gateway Policy khác. ` +
      `Nếu muốn xoá dứt điểm, vào Cloudflare Dashboard > Gateway > Policies, gỡ list khỏi policy thủ công rồi chạy lại.`
    );
  }

  return { deletedCount, skippedInUseCount };
};

export const getZeroTrustRules = () =>
  requestGateway("/rules", { method: "GET" });

export const upsertZeroTrustRule = async (wirefilterExpression, name = "CGPS Filter Lists", filters = ["dns"]) => {
  const { result: existingRules} = await getZeroTrustRules();
  const existingRule = existingRules.find(rule => rule.name === name);
  if (existingRule) {
    if (DEBUG) console.log(`Found "${existingRule.name}" in rules, updating...`);
    return updateZeroTrustRule(existingRule.id, wirefilterExpression, name, filters);
  }
  if (DEBUG) console.log(`No existing rule named "${name}", creating...`);
  return createZeroTrustRule(wirefilterExpression, name, filters);
};

export const createZeroTrustRule = async (wirefilterExpression, name = "CGPS Filter Lists", filters = ["dns"]) => {
  try {
    await requestGateway("/rules", {
      method: "POST",
      body: JSON.stringify({
        name,
        description: "Filter lists created by Cloudflare Gateway Pi-hole Scripts. Avoid editing this rule. Changing the name of this rule will break the script.",
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

export const updateZeroTrustRule = async (id, wirefilterExpression, name = "CGPS Filter Lists", filters = ["dns"]) => {
  try {
    await requestGateway(`/rules/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        name,
        description: "Filter lists created by Cloudflare Gateway Pi-hole Scripts. Avoid editing this rule. Changing the name of this rule will break the script.",
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

export const deleteZeroTrustRule = async (id) => {
  try {
    await requestGateway(`/rules/${id}`, { method: "DELETE" });
    console.log("Deleted rule successfully");
  } catch (err) {
    console.error(`Error occurred while deleting rule - ${err.toString()}`);
    throw err;
  }
};

export const upsertZeroTrustIPRule = async (lists, listName) => {
  const wirefilterIPExpression = lists
    .filter(({ name }) => name.startsWith("CGPS IP List"))
    .map(({ id }) => `net.dst.ip in \$${id}`)
    .join(" or ");
  console.log("Checking Network (IP) rule...");
  await upsertZeroTrustRule(wirefilterIPExpression, listName, ["l4"]);
};

export const upsertZeroTrustDNSRule = async (lists, listName) => {
  const wirefilterDNSExpression = lists
    .filter(({ name }) => name.startsWith("CGPS List"))
    .map(({ id }) => `any(dns.domains[*] in \$${id})`)
    .join(" or ");
  console.log("Checking DNS rule...");
  await upsertZeroTrustRule(wirefilterDNSExpression, listName, ["dns"]);
};

export const upsertZeroTrustSNIRule = async (lists, listName) => {
  const wirefilterSNIExpression = lists
    .filter(({ name }) => name.startsWith("CGPS List"))
    .map(({ id }) => `any(net.sni.domains[*] in \$${id})`)
    .join(" or ");
  console.log("Creating SNI rule...");
  await upsertZeroTrustRule(wirefilterSNIExpression, listName, ["l4"]);
};
