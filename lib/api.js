import { BLOCK_PAGE_ENABLED, DEBUG, FAST_MODE, FAST_MODE_CONCURRENCY, LIST_ITEM_SIZE } from "./constants.js";
import { requestGateway } from "./helpers.js";
import { runWithConcurrency } from "./utils.js";

// Số luồng chạy song song cho các thao tác hàng loạt (fetch/patch/create/delete).
// FAST_MODE=0 -> 1 (tuần tự, y hệt hành vi gốc). FAST_MODE=1 -> FAST_MODE_CONCURRENCY.
const CONCURRENCY = FAST_MODE ? FAST_MODE_CONCURRENCY : 1;

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

  // Process all the patches. Sequential by default, or with bounded
  // concurrency when FAST_MODE=1.
  await runWithConcurrency(Object.entries(patches).map(([listId, patch]) => async () => {
    const appends = !!patch.append ? patch.append.length : 0;
    const removals = !!patch.remove ? patch.remove.length : 0;
    console.log(`Updating list "${cgpsLists.find(list => list.id === listId).name}"${appends ? `, ${appends} additions` : ''}${removals ? `, ${removals} removals` : ''}`);
    await patchExistingList(listId, patch);
  }), CONCURRENCY);

  // Are there any more appends remaining?
  let createdListsCount = 0;
  if (toAdd.length) {
    // We'll need to create new list(s)
    const chunkPrefix = `${prefix} - Chunk `;
    const nextListNumber = Math.max(0, ...cgpsLists.map(list => parseInt(list.name.replace(chunkPrefix, ''))).filter(x => Number.isInteger(x))) + 1;
    createdListsCount = Math.ceil(toAdd.length / LIST_ITEM_SIZE);

    // CẢNH BÁO CHỦ ĐỘNG TRƯỚC KHI GỌI API: `lists` ở trên là TOÀN BỘ list
    // của tài khoản (mọi family: domain + IP + list tự tạo tay), không chỉ
    // riêng family này. Nếu tổng số list hiện có + số list mới cần tạo sẽ
    // vượt giới hạn cứng 300 list/tài khoản của Cloudflare, in cảnh báo rõ
    // ràng NGAY TỪ ĐẦU thay vì để tự khám phá qua lỗi 400 giữa chừng (VD:
    // đồng bộ domain dùng hết 295/300, family IP cần thêm 59 list nữa sẽ
    // chắc chắn thất bại - biết trước điều này giúp tính toán/dọn dẹp kịp
    // thời thay vì chờ crash).
    const projectedTotal = (lists?.length || 0) + createdListsCount;
    if (projectedTotal > 300) {
      console.warn(
        `⚠️⚠️⚠️ CẢNH BÁO TRƯỚC: tài khoản hiện có ${lists?.length || 0} list, cần tạo thêm ${createdListsCount} list nữa ` +
        `cho "${prefix}" → tổng dự kiến ${projectedTotal}/300 - VƯỢT giới hạn cứng của Cloudflare. ` +
        `Nhiều khả năng một phần "${prefix}" sẽ KHÔNG tạo được (Cloudflare sẽ từ chối bằng lỗi 400 khi đầy). ` +
        `Cân nhắc: chạy defragment-lists.yml để dọn list rỗng, giảm bớt nguồn dữ liệu, hoặc không dùng đồng thời ` +
        `cả blocklist domain lớn và IP blocklist lớn nếu tổng vượt 300.`
      );
    }

    await createZeroTrustListsOneByOne(toAdd, nextListNumber, { prefix, type });
  }

  return {
    totalItems: items.length,
    existingListsCount: cgpsLists.length,
    patchedListsCount: Object.keys(patches).length,
    createdListsCount,
    currentListsCount: cgpsLists.length + createdListsCount,
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
export const createZeroTrustListsOneByOne = async (items, startingListNumber = 1, { prefix = "CGPS List", type = "DOMAIN" } = {}) => {
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
      } catch (err) {
        console.error(`Could not create "${listName}" - ${err.toString()}`);
        throw err;
      }
    });
  }

  // Sequential by default, or with bounded concurrency when FAST_MODE=1.
  await runWithConcurrency(tasks, CONCURRENCY);
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
