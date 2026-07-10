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
  memoize,
  notify,
  notifySyncReport,
  readFile,
  runStats,
  setGithubOutput,
} from "./lib/utils.js";

// Tính năng hoàn toàn tuỳ chọn: nếu chưa tải ip_blocklist.txt (vì
// IP_BLOCKLIST_URLS chưa cấu hình), bỏ qua êm - không lỗi, không ảnh hưởng
// tới phần domain blocklist.
if (!existsSync(PROCESSING_FILENAME.IP_BLOCKLIST)) {
  console.log(
    `Không tìm thấy ${PROCESSING_FILENAME.IP_BLOCKLIST} - bỏ qua đồng bộ IP blocklist. ` +
    `Để bật tính năng này, cấu hình Secret IP_BLOCKLIST_URLS rồi chạy lại download_lists.js.`
  );
  process.exit(0);
}

const ipSet = new Map();
const ips = [];
let processedCount = 0;
let invalidCount = 0;
let duplicateCount = 0;
const memoizedTrim = memoize((v) => v.trim());

console.log(`Processing ${PROCESSING_FILENAME.IP_BLOCKLIST}`);
await readFile(resolve(`./${PROCESSING_FILENAME.IP_BLOCKLIST}`), (line) => {
  const _line = memoizedTrim(line);

  if (!_line) return;
  if (isComment(_line)) return;

  processedCount++;

  // Một số feed dùng định dạng "IP # ghi chú" hoặc "IP;ghi chú" - chỉ lấy phần IP đầu dòng.
  const value = _line.split(/[\s#;]/)[0];

  if (!isValidIPOrCIDR(value)) {
    invalidCount++;
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
    console.log(
      "Dry run complete - no IP lists were created. If this was not intended, please remove the DRY_RUN environment variable and try again."
    );
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
    // Xem giải thích chi tiết ở cf_list_create.js - không crash bằng
    // unhandled exception, báo lỗi rõ ràng, vẫn thoát với mã lỗi thật.
    console.error(`❌ Đồng bộ IP blocklist KHÔNG hoàn tất: ${err.message}`);
    await notify(
      `❌ <b>Đồng bộ IP Blocklist KHÔNG hoàn tất</b>\n` +
      `${err.message}\n\n` +
      `Nguyên nhân phổ biến nhất: tài khoản đã đạt giới hạn 300 list/tài khoản của Cloudflare. ` +
      `Hãy chạy defragment-lists.yml để dọn dẹp, hoặc giảm bớt nguồn IP_BLOCKLIST_URLS.`
    );
    process.exitCode = 1;
  }
})();
