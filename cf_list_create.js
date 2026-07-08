import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { getZeroTrustLists, synchronizeZeroTrustLists } from "./lib/api.js";
import {
  DEBUG,
  DRY_RUN,
  LIST_ITEM_LIMIT,
  LIST_ITEM_SIZE,
  PROCESSING_FILENAME,
} from "./lib/constants.js";
import { normalizeDomain } from "./lib/helpers.js";
import {
  extractDomain,
  isComment,
  isValidDomain,
  memoize,
  notify,
  notifySyncReport,
  readFile,
  runStats,
  setGithubOutput,
} from "./lib/utils.js";

const allowlistFilename = existsSync(PROCESSING_FILENAME.OLD_ALLOWLIST)
  ? PROCESSING_FILENAME.OLD_ALLOWLIST
  : PROCESSING_FILENAME.ALLOWLIST;
const blocklistFilename = existsSync(PROCESSING_FILENAME.OLD_BLOCKLIST)
  ? PROCESSING_FILENAME.OLD_BLOCKLIST
  : PROCESSING_FILENAME.BLOCKLIST;
const allowlist = new Map();
const blocklist = new Map();
const domains = [];
let processedDomainCount = 0;
let unnecessaryDomainCount = 0;
let duplicateDomainCount = 0;
let allowedDomainCount = 0;
const memoizedNormalizeDomain = memoize(normalizeDomain);

// Check if the blocklist.txt and allowlist.txt files exist
for (const filename of [allowlistFilename, blocklistFilename]) {
  if (!existsSync(filename)) {
    console.error(`File not found: ${filename}. Please create a block/allowlist first, or run download_lists.js to download the recommended lists.`);
    process.exit(1);
  }
}

// Log chẩn đoán: kích thước file THẬT trên đĩa ngay trước khi xử lý.
// Nếu số "Number of processed domains" ở dưới thấp bất thường so với
// kích thước file ở đây, vấn đề nằm ở BƯỚC XỬ LÝ (parse/dedup/validate).
// Nếu 2 số liệu này VÀ khớp nhau nhưng Cloudflare vẫn chỉ hiện it entries,
// vấn đề nằm ở BƯỚC ĐỒNG BỘ LÊN CLOUDFLARE (synchronizeZeroTrustLists) -
// hai khả năng hoàn toàn khác nhau, cần phân biệt rõ để debug đúng chỗ.
for (const filename of [allowlistFilename, blocklistFilename]) {
  const stats = statSync(filename);
  const rawLineCount = readFileSync(filename, "utf8").split("\n").filter(l => l.trim()).length;
  console.log(`[Chẩn đoán] ${filename}: ${stats.size.toLocaleString()} bytes, ${rawLineCount.toLocaleString()} dòng không rỗng trên đĩa`);
}

// Read allowlist
console.log(`Processing ${allowlistFilename}`);
await readFile(resolve(`./${allowlistFilename}`), (line) => {
  const _line = line.trim();

  if (!_line) return;

  if (isComment(_line)) return;

  const domain = memoizedNormalizeDomain(_line, true);

  if (!isValidDomain(domain)) return;

  allowlist.set(domain, 1);
});

// Read blocklist
console.log(`Processing ${blocklistFilename}`);
await readFile(resolve(`./${blocklistFilename}`), (line, rl) => {
  if (domains.length === LIST_ITEM_LIMIT) {
    return;
  }

  const _line = line.trim();

  if (!_line) return;

  // Check if the current line is a comment in any format
  if (isComment(_line)) return;

  // Remove prefixes and suffixes in hosts, wildcard or adblock format
  const domain = memoizedNormalizeDomain(_line);

  // Check if it is a valid domain which is not a URL or does not contain
  // characters like * in the middle of the domain
  if (!isValidDomain(domain)) return;

  processedDomainCount++;

  if (allowlist.has(domain)) {
    if (DEBUG) console.log(`Found ${domain} in allowlist - Skipping`);
    allowedDomainCount++;
    return;
  }

  if (blocklist.has(domain)) {
    if (DEBUG) console.log(`Found ${domain} in blocklist already - Skipping`);
    duplicateDomainCount++;
    return;
  }

  // Get all the levels of the domain and check from the highest
  // because we are blocking all subdomains
  // Example: fourth.third.example.com => ["example.com", "third.example.com", "fourth.third.example.com"]
  for (const item of extractDomain(domain).slice(1)) {
    // Check for any higher level domain matches in the allowlist
    if (allowlist.has(item)) {
      if (DEBUG) console.log(`Found parent domain ${item} in allowlist - Skipping ${domain}`);
      allowedDomainCount++;
      return;
    }

    if (!blocklist.has(item)) continue;

    // The higher-level domain is already blocked
    // so it's not necessary to block this domain
    if (DEBUG) console.log(`Found ${item} in blocklist already - Skipping ${domain}`);
    unnecessaryDomainCount++;
    return;
  }

  blocklist.set(domain, 1);
  domains.push(domain);

  if (domains.length === LIST_ITEM_LIMIT) {
    console.log(
      "Maximum number of blocked domains reached - Stopping processing blocklist..."
    );
    rl.close();
  }
});

const numberOfLists = Math.ceil(domains.length / LIST_ITEM_SIZE);

console.log("\n\n");
console.log(`Number of processed domains: ${processedDomainCount}`);
console.log(`Number of duplicate domains: ${duplicateDomainCount}`);
console.log(`Number of unnecessary domains: ${unnecessaryDomainCount}`);
console.log(`Number of allowed domains: ${allowedDomainCount}`);
console.log(`Number of blocked domains: ${domains.length}`);
console.log(`Number of lists to be created: ${numberOfLists}`);
console.log("\n\n");

(async () => {
  if (DRY_RUN) {
    console.log(
      "Dry run complete - no lists were created. If this was not intended, please remove the DRY_RUN environment variable and try again."
    );
    return;
  }

  console.log(
    `Creating ${numberOfLists} lists for ${domains.length} domains...`
  );

  try {
    const syncStats = await synchronizeZeroTrustLists(domains);
    const executionTimeMs = Date.now() - runStats.startedAt;

    // Fetch the TRUE total lists across the whole account (all families:
    // domain + IP + anything else) for an accurate 300-list capacity warning.
    const { result: allLists } = await getZeroTrustLists();
    const totalAccountListsCount = allLists?.length ?? syncStats.currentListsCount;

    // Expose real numbers to the workflow via $GITHUB_OUTPUT, consumed by
    // later notification steps if needed.
    setGithubOutput("total_records", syncStats.totalItems);
    setGithubOutput("current_lists", syncStats.currentListsCount);
    setGithubOutput("created_lists", syncStats.createdListsCount);
    setGithubOutput("updated_lists", syncStats.patchedListsCount);
    setGithubOutput("deleted_lists", 0);
    setGithubOutput("total_account_lists", totalAccountListsCount);
    setGithubOutput("execution_time", `${Math.round(executionTimeMs / 1000)}s`);
    setGithubOutput("retry_count", runStats.retryCount);

    await notifySyncReport({
      label: "Domain Blocklist",
      totalItems: syncStats.totalItems,
      currentListsCount: syncStats.currentListsCount,
      createdListsCount: syncStats.createdListsCount,
      patchedListsCount: syncStats.patchedListsCount,
      totalAccountListsCount,
      executionTimeMs,
    });
  } catch (err) {
    // QUAN TRỌNG: bắt lỗi ở đây thay vì để crash bằng unhandled exception
    // (stack trace khó hiểu như trước). Vẫn CHỦ ĐỘNG báo lỗi rõ ràng và
    // THOÁT VỚI MÃ LỖI (process.exit(1)) - KHÔNG giả vờ "thành công" khi
    // thực chất có domain không đồng bộ được lên Cloudflare. Nguyên nhân
    // phổ biến nhất: tài khoản đã đạt giới hạn 300 list - xem message lỗi
    // thật (đã sửa để hiện đúng lý do Cloudflare trả về) để biết chính xác.
    console.error(`❌ Đồng bộ domain KHÔNG hoàn tất: ${err.message}`);
    await notify(
      `❌ <b>Đồng bộ Domain Blocklist KHÔNG hoàn tất</b>\n` +
      `${err.message}\n\n` +
      `Nguyên nhân phổ biến nhất: tài khoản đã đạt giới hạn 300 list/tài khoản của Cloudflare. ` +
      `Hãy chạy defragment-lists.yml để dọn dẹp, hoặc giảm bớt nguồn BLOCKLIST_URLS.`
    );
    process.exitCode = 1;
  }
})();
