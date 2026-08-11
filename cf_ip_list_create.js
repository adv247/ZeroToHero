import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { getZeroTrustLists, synchronizeZeroTrustLists } from "./lib/api.js";
import {
  DRY_RUN,
  LIST_ITEM_LIMIT,
  LIST_ITEM_SIZE,
  PROCESSING_FILENAME,
} from "./lib/constants.js";
import {
  isComment,
  isValidIPOrCIDR,
  isValidIPv4,
  memoize,
  notify,
  notifySyncReport,
  readFile,
  runStats,
  setGithubOutput,
} from "./lib/utils.js";

if (!existsSync(PROCESSING_FILENAME.IP_BLOCKLIST)) {
  console.log(
    `Không tìm thấy ${PROCESSING_FILENAME.IP_BLOCKLIST} - bỏ qua đồng bộ IP blocklist. ` +
    `Để bật tính năng này, cấu hình Secret IP_BLOCKLIST_URLS rồi chạy lại download_lists.js.`
  );
  process.exit(0);
}

const ipv4ToInt = (ip) =>
  ip.split(".").reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;

const isIPv4WithinCIDR = (value, allowCidr) => {
  const [valueIp, valueBitsStr] = value.split("/");
  const [allowIp, allowBitsStr] = allowCidr.split("/");

  if (!isValidIPv4(valueIp) || !isValidIPv4(allowIp)) return false;

  const allowBits = allowBitsStr !== undefined ? parseInt(allowBitsStr, 10) : 32;
  const valueBits = valueBitsStr !== undefined ? parseInt(valueBitsStr, 10) : 32;

  if (valueBits < allowBits) return false;

  const mask = allowBits === 0 ? 0 : (~0 << (32 - allowBits)) >>> 0;
  return (ipv4ToInt(valueIp) & mask) === (ipv4ToInt(allowIp) & mask);
};

const loadIpAllowlist = async () => {
  const exactSet = new Set();
  const cidrs = [];

  if (!existsSync(PROCESSING_FILENAME.IP_ALLOWLIST)) {
    console.log(
      `Không tìm thấy ${PROCESSING_FILENAME.IP_ALLOWLIST} - tính năng IP_ALLOWLIST_URLS chưa được cấu hình, bỏ qua.`
    );
    return { exactSet, cidrs };
  }

  const memoizedTrim = memoize((v) => v.trim());
  let count = 0;

  console.log(`Processing ${PROCESSING_FILENAME.IP_ALLOWLIST} (danh sách IP được BỎ QUA khỏi blocklist)`);
  await readFile(resolve(`./${PROCESSING_FILENAME.IP_ALLOWLIST}`), (line) => {
    const _line = memoizedTrim(line);
    if (!_line) return;
    if (isComment(_line)) return;

    const value = _line.split(/[\s#;]/)[0];
    if (!isValidIPOrCIDR(value)) return;

    exactSet.add(value);
    if (value.includes("/")) cidrs.push(value);
    count++;
  });

  console.log(`Đã tải ${count} mục IP_ALLOWLIST (sẽ được loại khỏi IP blocklist trước khi đồng bộ lên Cloudflare).`);
  return { exactSet, cidrs };
};

const ipSet = new Map();
const ips = [];
let processedCount = 0;
let invalidCount = 0;
let duplicateCount = 0;
let allowlistedCount = 0;
const memoizedTrim = memoize((v) => v.trim());

const { exactSet: ipAllowlistExactSet, cidrs: ipAllowlistCidrs } = await loadIpAllowlist();

const isAllowlisted = (value) => {
  if (ipAllowlistExactSet.has(value)) return true;
  if (!value.includes(":")) {
    return ipAllowlistCidrs.some((allowCidr) => isIPv4WithinCIDR(value, allowCidr));
  }
  return false;
};

console.log(`Processing ${PROCESSING_FILENAME.IP_BLOCKLIST}`);
await readFile(resolve(`./${PROCESSING_FILENAME.IP_BLOCKLIST}`), (line) => {
  const _line = memoizedTrim(line);

  if (!_line) return;
  if (isComment(_line)) return;

  processedCount++;

  const value = _line.split(/[\s#;]/)[0];

  if (!isValidIPOrCIDR(value)) {
    invalidCount++;
    return;
  }

  if (isAllowlisted(value)) {
    allowlistedCount++;
    return;
  }

  if (ipSet.has(value)) {
    duplicateCount++;
    return;
  }

  ipSet.set(value, 1);
  ips.push(value);
});

const numberOfLists = Math.ceil(ips.length / LIST_ITEM_SIZE);

console.log(`Number of processed lines: ${processedCount}`);
console.log(`Number of invalid entries: ${invalidCount}`);
console.log(`Number of duplicate entries: ${duplicateCount}`);
console.log(`Number of entries bypassed via IP_ALLOWLIST_URLS: ${allowlistedCount}`);
console.log(`Number of IP/CIDR entries to block: ${ips.length}`);
console.log(`Number of lists to be created: ${numberOfLists}`);
console.log("\n\n");

if (ips.length > LIST_ITEM_LIMIT) {
  console.warn(
    `Cảnh báo: số lượng IP/CIDR (${ips.length}) vượt quá CLOUDFLARE_LIST_ITEM_LIMIT (${LIST_ITEM_LIMIT}). ` +
    `Các mục vượt giới hạn sẽ KHÔNG được thêm vào. Hãy giảm bớt nguồn IP_BLOCKLIST_URLS.`
  );
}

const limitedIps = ips.slice(0, LIST_ITEM_LIMIT);

(async () => {
  if (DRY_RUN) {
    console.log("Dry run complete - no IP lists were created.");
    return;
  }

  console.log(`Creating ${numberOfLists} IP lists for ${limitedIps.length} entries...`);

  try {
    const syncStats = await synchronizeZeroTrustLists(limitedIps, { prefix: "CGPS IP List", type: "IP" });
    const executionTimeMs = Date.now() - runStats.startedAt;

    const { result: allLists } = await getZeroTrustLists();
    const totalAccountListsCount = allLists?.length ?? syncStats.currentListsCount;

    setGithubOutput("ip_total_records", syncStats.totalItems);
    setGithubOutput("ip_current_lists", syncStats.currentListsCount);
    setGithubOutput("ip_created_lists", syncStats.createdListsCount);
    setGithubOutput("ip_updated_lists", syncStats.patchedListsCount);
    setGithubOutput("ip_allowlisted_count", allowlistedCount);
    setGithubOutput("truncated_count", syncStats.truncatedCount || 0);
    setGithubOutput("total_account_lists", totalAccountListsCount);

    await notifySyncReport({
      label: "IP Blocklist",
      totalItems: syncStats.totalItems,
      currentListsCount: syncStats.currentListsCount,
      createdListsCount: syncStats.createdListsCount,
      patchedListsCount: syncStats.patchedListsCount,
      truncatedCount: syncStats.truncatedCount,
      totalAccountListsCount,
      executionTimeMs,
    });
  } catch (err) {
    console.error(`❌ Đồng bộ IP blocklist KHÔNG hoàn tất: ${err.message}`);
    await notify(
      `❌ Đồng bộ IP Blocklist KHÔNG hoàn tất\n${err.message}\n\n` +
      `Nguyên nhân phổ biến nhất: tài khoản đã đạt giới hạn 300 list/tài khoản của Cloudflare. ` +
      `Hãy chạy defragment-lists.yml để dọn dẹp, hoặc giảm bớt nguồn IP_BLOCKLIST_URLS.`
    );
    process.exitCode = 1;
  }
})();
