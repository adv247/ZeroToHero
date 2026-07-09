import { once } from "node:events";
import { appendFileSync, existsSync } from "node:fs";
import { createReadStream, createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { CLOUDFLARE_RATE_LIMIT_BACKOFF_SCHEDULE, RATE_LIMITING_HTTP_ERROR_CODE } from "./constants.js";

/**
 * Runtime stats collected during a script run, used to build rich
 * Discord/Telegram reports and GITHUB_OUTPUT values. A plain mutable object
 * (not a class) so every module importing it shares the same counters.
 */
export const runStats = {
  retryCount: 0,
  startedAt: Date.now(),
};

/**
 * Formats a millisecond duration as a short human string, e.g. "45s" or "2m 15s".
 * @param {number} ms
 */
export const formatDuration = (ms) => {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
};

/**
 * Writes a key=value pair to the GitHub Actions output file ($GITHUB_OUTPUT),
 * so a later workflow step can read it via `steps.<id>.outputs.<key>`.
 * Safe no-op when not running inside GitHub Actions (e.g. local runs) or if
 * the value contains characters that would break the file format.
 * @param {string} key
 * @param {string|number|boolean} value
 */
export const setGithubOutput = (key, value) => {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return; // Not running in GitHub Actions - silently skip

  const stringValue = String(value);
  if (stringValue.includes("\n")) {
    // Multi-line values need the delimiter form; none of our current
    // values are multi-line, so keep this simple and safe.
    console.warn(`setGithubOutput: skipping multi-line value for "${key}"`);
    return;
  }

  try {
    appendFileSync(outputPath, `${key}=${stringValue}\n`);
  } catch (err) {
    console.warn(`setGithubOutput: could not write "${key}":`, err.message);
  }
};

if (!globalThis.fetch) {
  globalThis.fetch = (await import("node-fetch")).default;
}

/**
 * Checks if the value is a valid domain.
 * @param {string} value The value to be checked.
 */
export const isValidDomain = (value) =>
  /^\b((?=[a-z0-9-]{1,63}\.)(xn--)?[a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,63}\b$/.test(
    value
  );

/**
 * Extracts all subdomains from a domain including itself.
 * @param {string} domain The domain to be extracted.
 * @returns {string[]}
 */
export const extractDomain = (domain) => {
  const parts = domain.split(".");
  const extractedDomains = [];

  for (let i = 0; i < parts.length; i++) {
    const subdomains = parts.slice(i).join(".");

    extractedDomains.unshift(subdomains);
  }

  return extractedDomains;
};

/**
 * Checks if the value is a valid IPv4 address, optionally with a CIDR suffix.
 * Examples: "1.2.3.4", "1.2.3.0/24".
 * @param {string} value The value to be checked.
 */
export const isValidIPv4 = (value) => {
  const [ip, cidr] = value.split("/");
  if (cidr !== undefined && !/^([0-9]|[1-2][0-9]|3[0-2])$/.test(cidr)) return false;
  return /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/.test(ip);
};

/**
 * Checks if the value is a valid IPv6 address, optionally with a CIDR suffix.
 * This is an intentionally permissive check (not a full RFC validator) since
 * Cloudflare's API performs the authoritative validation on submission.
 * @param {string} value The value to be checked.
 */
export const isValidIPv6 = (value) => {
  const [ip, cidr] = value.split("/");
  if (cidr !== undefined && !/^([0-9]|[1-9][0-9]|1[0-1][0-9]|12[0-8])$/.test(cidr)) return false;
  return /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/.test(ip) && ip.includes(":");
};

/**
 * Checks if the value is a valid IPv4/IPv6 address or CIDR range.
 * @param {string} value The value to be checked.
 */
export const isValidIPOrCIDR = (value) => isValidIPv4(value) || isValidIPv6(value);

/**
 * Checks if the value is a comment.
 * @param {string} value The value to be checked.
 */
export const isComment = (value) =>
  value.startsWith("#") ||
  value.startsWith("//") ||
  value.startsWith("!") ||
  value.startsWith("/*") ||
  value.startsWith("*/");

/**
 * Downloads files and concatenates them into one file.
 * @param {string} filePath The path to the file being written to.
 * @param {string[]} urls The URLs to the files to be downloaded.
 */
// ============================================================================
// CACHE HTTP CONDITIONAL GET - tối ưu băng thông
// ============================================================================
// Nhiều nguồn blocklist (đặc biệt HaGeZi) hầu như KHÔNG đổi giữa các lần
// chạy hàng ngày. Thay vì luôn tải lại TOÀN BỘ nội dung (có nguồn hàng chục
// MB), dùng cơ chế HTTP Conditional GET chuẩn: gửi kèm ETag/Last-Modified từ
// lần tải trước; nếu server trả về "304 Not Modified" (nghĩa là "không có gì
// mới"), dùng lại đúng nội dung đã lưu từ lần trước thay vì tải lại - tiết
// kiệm gần như toàn bộ băng thông cho các nguồn không đổi. Cache được lưu
// trên đĩa (thư mục .cgps_cache/) và cần GitHub Actions cache
// (actions/cache@v4) để giữ lại giữa các lần chạy - xem update-filter-lists.yml.
const CACHE_DIR = ".cgps_cache";
const CACHE_META_FILE = `${CACHE_DIR}/meta.json`;

const urlCacheKey = (url) => createHash("sha256").update(url).digest("hex");

const loadCacheMeta = () => {
  if (!existsSync(CACHE_META_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_META_FILE, "utf8"));
  } catch {
    return {};
  }
};

const saveCacheMeta = (meta) => {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_META_FILE, JSON.stringify(meta));
};

/**
 * Downloads a list of URLs, merging their content (one per line, separated
 * by a blank line) into a single file.
 * Uses fetchRetry (with the escalating 429 backoff) instead of a bare fetch,
 * and explicitly checks response.ok - a URL returning 404/403/429 used to
 * silently write its (tiny) error page into the file with ZERO indication
 * of failure: total domain/IP counts would be far lower than expected, the
 * whole run would still "succeed", and nothing in the logs or notifications
 * would explain why. Now every failure is retried with backoff and, if it
 * still fails after all retries, clearly logged and reported - never silent.
 * @param {string} filePath
 * @param {string[]} urls
 * @returns {Promise<{url: string, ok: boolean, bytes: number}[]>} Per-URL result summary.
 */
export const downloadFiles = async (filePath, urls) => {
  const results = [];
  const cacheMeta = loadCacheMeta();
  // QUAN TRỌNG: phải tạo thư mục cache TRƯỚC vòng lặp - nếu chỉ tạo trong
  // saveCacheMeta() (gọi sau vòng lặp), việc ghi file cache từng URL bên
  // trong vòng lặp sẽ lỗi ENOENT vì thư mục chưa tồn tại (bug thật, phát
  // hiện và sửa qua test thực tế).
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

  // Note: This function used to download files in parallel using `Promise.all`.
  // This was changed to download files sequentially to avoid rate limiting and other issues (servers don't react well to 20+ separate requests in under 1 second).
  for (const url of urls) {
    try {
      const key = urlCacheKey(url);
      const cacheEntry = cacheMeta[key];
      const cachedFilePath = `${CACHE_DIR}/${key}.txt`;
      const conditionalHeaders = {};
      if (cacheEntry?.etag) conditionalHeaders["If-None-Match"] = cacheEntry.etag;
      if (cacheEntry?.lastModified) conditionalHeaders["If-Modified-Since"] = cacheEntry.lastModified;

      const response = await fetchRetry(url, { headers: conditionalHeaders });

      // 304 = nguồn xác nhận "không có gì mới" kể từ lần tải trước - dùng lại
      // nội dung đã lưu trong cache thay vì tải lại, tiết kiệm gần như toàn
      // bộ băng thông cho nguồn này ở lần chạy này.
      if (response.status === 304 && existsSync(cachedFilePath)) {
        const cached = readFileSync(cachedFilePath);
        appendFileSync(filePath, cached);
        appendFileSync(filePath, "\n");
        console.log(`  ♻️  ${url} - KHÔNG ĐỔI (304), dùng cache - 0 bytes tải mới`);
        results.push({ url, ok: true, bytes: 0, cached: true });
        continue;
      }

      // fetchRetry already retries on 429 with backoff and throws after
      // exhausting all attempts, but a non-429 non-2xx response (404, etc.)
      // resolves normally from fetch() itself - must check explicitly.
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      // QUAN TRỌNG: response.body từ fetch() thật (Node.js undici) là Web
      // ReadableStream (Web Streams API), KHÔNG PHẢI Node.js Readable stream
      // - nó KHÔNG có phương thức .on(). Phải chuyển đổi qua Readable.fromWeb()
      // trước khi dùng .on()/pipeline theo kiểu Node stream. Bug này từng lọt
      // qua vì test trước đó dùng mock Node Readable (có .on() sẵn), không
      // phản ánh đúng hành vi của fetch() thật.
      const nodeStream = Readable.fromWeb(response.body);
      const writeStream = createWriteStream(filePath, { flags: "a" });
      const cacheWriteStream = createWriteStream(cachedFilePath, { flags: "w" });
      let bytes = 0;
      nodeStream.on("data", (chunk) => {
        bytes += chunk.length;
        cacheWriteStream.write(chunk);
      });

      await pipeline(nodeStream, writeStream, { end: false });
      writeStream.end("\n");
      cacheWriteStream.end();
      // QUAN TRỌNG: phải chờ stream ghi xong HẲN (sự kiện "finish") trước khi
      // vòng lặp mở createWriteStream mới (flags "a") cho URL tiếp theo trên
      // CÙNG file. Trước đây không await việc này -> race condition thật sự:
      // 2 stream ghi đè/chồng lên nhau trên cùng file có thể làm MẤT dữ liệu
      // của URL trước đó (đã tái hiện và xác nhận bằng test thực tế).
      await once(writeStream, "finish");
      await once(cacheWriteStream, "finish");

      // Lưu lại ETag/Last-Modified cho lần tải kế tiếp - chỉ lưu khi server
      // thực sự có cung cấp (không phải mọi nguồn đều hỗ trợ).
      const etag = response.headers.get("etag");
      const lastModified = response.headers.get("last-modified");
      if (etag || lastModified) {
        cacheMeta[key] = { url, etag, lastModified };
      }

      console.log(`  ✅ ${url} - ${bytes.toLocaleString()} bytes`);
      results.push({ url, ok: true, bytes });
    } catch (err) {
      // KHÔNG để 1 URL lỗi làm mất trắng dữ liệu của các URL khác đã tải
      // thành công trước đó trong CÙNG lần chạy - log rõ ràng và tiếp tục.
      console.error(`  ❌ ${url} - LỖI: ${err.message}`);
      results.push({ url, ok: false, bytes: 0, error: err.message });
    }
  }

  saveCacheMeta(cacheMeta);

  const failedUrls = results.filter(r => !r.ok);
  if (failedUrls.length) {
    console.warn(`⚠️ ${failedUrls.length}/${urls.length} URL tải KHÔNG thành công (xem chi tiết ❌ ở trên). Dữ liệu từ các URL này KHÔNG có trong kết quả cuối cùng.`);
  }

  const cachedCount = results.filter(r => r.cached).length;
  if (cachedCount) {
    console.log(`♻️  ${cachedCount}/${urls.length} nguồn dùng lại cache (không đổi từ lần trước) - tiết kiệm băng thông.`);
  }

  return results;
};

/**
 * @callback onLine
 * @param {string} line The current line.
 * @param {ReturnType<typeof createInterface>} rl The readline interface.
 */

/**
 * Asynchronously reads a file line by line.
 * @param {string} filePath The path to the file.
 * @param {onLine} onLine The callback executed on each line read.
 */
export const readFile = async (filePath, onLine) => {
  try {
    const rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => onLine(line, rl));

    await once(rl, "close");
  } catch (err) {
    console.error(
      `Error occurred while reading ${basename(filePath)} - ${err.toString()}`
    );
    throw err;
  }
};

/**
 * Memoizes a function
 * @template T The argument type of the function.
 * @template R The return type of the function.
 * @param {(...fnArgs: T[]) => R} fn The function to be memoized.
 */
export const memoize = (fn) => {
  const cache = new Map();

  return (...args) => {
    const key = args.join("-");

    if (cache.has(key)) return cache.get(key);

    const result = fn(...args);

    cache.set(key, result);
    return result;
  };
};

/**
 * Waits for a period of time
 * @param {number} ms The time to wait in milliseconds.
 */
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs an array of task-producing functions with a bounded number running
 * at the same time (a simple worker-pool). Used to speed up bulk Cloudflare
 * API operations when FAST_MODE is enabled, while keeping the number of
 * simultaneous requests capped and predictable.
 * Falls back to running everything sequentially if concurrency <= 1.
 * @template T
 * @param {Array<() => Promise<T>>} tasks Array of functions, each returning a promise when called.
 * @param {number} concurrency Max number of tasks running at the same time.
 * @returns {Promise<T[]>} Results in the same order as the input tasks.
 */
export const runWithConcurrency = async (tasks, concurrency) => {
  if (!tasks.length) return [];

  // Sequential fallback - identical behaviour to a plain for..of loop.
  if (concurrency <= 1) {
    const results = [];
    for (const task of tasks) results.push(await task());
    return results;
  }

  const results = new Array(tasks.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < tasks.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await tasks[currentIndex]();
    }
  };

  const workerCount = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  return results;
};

/**
 * Sends a message to a Discord-compatible webhook.
 * @param {url|string} url The webhook URL.
 * @param {string} message The message to be sent.
 * @returns {Promise}
 */
async function sendMessageToWebhook(url, message) {
  // Create the payload object with the message
  // The message is provided as 2 different properties to improve compatibility with webhook servers outside Discord
  const payload = { content: message, body: message };

  // Send a POST request to the webhook url with the payload as JSON
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // Check if the request was successful
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    } else {
      return true;
    }
  } catch (error) {
    console.error('Error sending message to webhook:', error);
    return false;
  }
}

/**
 * Sends a CGPS notification to a Discord-compatible webhook.
 * Automatically checks if the webhook URL exists.
 * @param {string} msg The message to be sent.
 * @returns {Promise}
 */
export async function notifyWebhook(msg) {
  // Check if the webhook URL exists
  const webhook_url = process.env.DISCORD_WEBHOOK_URL;

  if (webhook_url && webhook_url.startsWith('http')) {
    // Send the message to the webhook
    try {
      await sendMessageToWebhook(webhook_url, `CGPS: ${msg}`);
    } catch (e) {
      console.error('Error sending message to Discord webhook:', e);
    }
  }
  // Not logging the lack of a webhook URL since it's not a feature everyone would use
}

/**
 * Sends a message to a Telegram chat via a Telegram Bot.
 * Create a bot with @BotFather on Telegram to get a bot token, and get the
 * numeric chat id (personal chat, group or channel) to send messages to.
 * @param {string} token The Telegram Bot API token.
 * @param {string} chatId The destination chat id.
 * @param {string} message The message to be sent.
 * @returns {Promise<boolean>}
 */
async function sendMessageToTelegram(token, chatId, message) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP error! Status: ${response.status} - ${body}`);
    }

    return true;
  } catch (error) {
    console.error('Error sending message to Telegram:', error);
    return false;
  }
}

/**
 * Sends a CGPS notification to a Telegram chat via a Telegram Bot.
 * Automatically checks if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID exist.
 * Safe to call even when Telegram isn't configured - it's a silent no-op.
 * @param {string} msg The message to be sent. Supports basic HTML tags (<b>, <i>, <code>).
 * @returns {Promise}
 */
export async function notifyTelegram(msg) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (token && chatId) {
    try {
      await sendMessageToTelegram(token, chatId, `🔔 <b>CGPS</b>\n${msg}`);
    } catch (e) {
      console.error('Error sending message to Telegram:', e);
    }
  }
  // Not logging the lack of Telegram config since it's an optional feature
}

/**
 * Builds and sends a rich, dual-format sync report to every configured
 * notification channel (Discord gets a colored ```diff``` block, Telegram
 * gets an HTML-formatted plaintext report). All the conditional logic
 * (dynamic title, capacity warning, icons) lives here in JS instead of
 * nested GitHub Actions expressions, which is far less error-prone.
 * Counts only - never includes specific domain/IP values.
 * @param {Object} stats
 * @param {string} stats.label e.g. "Domain Blocklist" or "IP Blocklist"
 * @param {number} stats.totalItems
 * @param {number} stats.currentListsCount Lists in this family after the run
 * @param {number} stats.createdListsCount
 * @param {number} stats.patchedListsCount
 * @param {number} [stats.deletedListsCount]
 * @param {number} [stats.totalAccountListsCount] Total lists across the WHOLE Cloudflare account (all families), used for the 300-list capacity warning
 * @param {number} stats.executionTimeMs
 */
export async function notifySyncReport(stats) {
  const {
    label,
    totalItems,
    currentListsCount,
    createdListsCount,
    patchedListsCount,
    deletedListsCount = 0,
    totalAccountListsCount,
    executionTimeMs,
  } = stats;

  const fastMode = process.env.FAST_MODE === "1";
  const retryCount = runStats.retryCount;
  const executionTime = formatDuration(executionTimeMs);
  const capacityWarning = typeof totalAccountListsCount === "number" && totalAccountListsCount > 290;

  const title = capacityWarning
    ? "⚠️ CẢNH BÁO: SẮP CHẠM TRẦN DUNG LƯỢNG LIST"
    : `🛡️ Đồng bộ ${label} hoàn tất`;

  const capacityLine = capacityWarning
    ? `\n💥 Dung lượng đã vượt ngưỡng an toàn (${totalAccountListsCount}/300 lists toàn tài khoản)! Hãy bớt bớt nguồn blocklist hoặc chạy defragment ngay.\n`
    : "";

  const discordMessage =
    `**${title}**\n` +
    `\n` +
    `ℹ️ **Thông tin chung**\n` +
    `• Chế độ: \`${fastMode ? "FAST_MODE (song song)" : "Tuần tự"}\`\n` +
    `\n` +
    `📊 **Thống kê ${label}**\n` +
    `• Tổng bản ghi: \`${totalItems}\`\n` +
    `• Tổng số list: \`${currentListsCount}\`` + (typeof totalAccountListsCount === "number" ? ` (toàn tài khoản: \`${totalAccountListsCount}/300\`)` : "") + `\n` +
    "```diff\n" +
    `+ Tạo mới:   ${createdListsCount} list\n` +
    `! Cập nhật:  ${patchedListsCount} list\n` +
    `- Dọn dẹp:   ${deletedListsCount} list\n` +
    "```" +
    capacityLine +
    `\n⚡ **Hiệu năng**\n` +
    `• Thời gian xử lý: \`${executionTime}\`\n` +
    `• Số lần tự lùi lại (retry): \`${retryCount}\`\n` +
    `• Node.js: \`${process.version}\``;

  const telegramMessage =
    `<b>${title}</b>\n` +
    `------------------------------------------------\n` +
    `📊 <b>Thống kê ${label}</b>\n` +
    `- Tổng bản ghi: ${totalItems}\n` +
    `- Tổng số list: ${currentListsCount}` + (typeof totalAccountListsCount === "number" ? ` (toàn tài khoản: ${totalAccountListsCount}/300)` : "") + `\n` +
    `- Tạo mới: ${createdListsCount} | Cập nhật: ${patchedListsCount} | Dọn dẹp: ${deletedListsCount}\n` +
    (capacityWarning ? `\n⚠️ CẢNH BÁO: dung lượng đã vượt ngưỡng an toàn (${totalAccountListsCount}/300)! Hãy bớt bớt nguồn blocklist hoặc chạy defragment ngay.\n` : "") +
    `\n⚡ <b>Hiệu năng</b>\n` +
    `- Chế độ: ${fastMode ? "FAST_MODE (song song)" : "Tuần tự"}\n` +
    `- Thời gian xử lý: ${executionTime}\n` +
    `- Số lần tự lùi lại (retry): ${retryCount}\n` +
    `- Node.js: ${process.version}`;

  await Promise.all([
    notifyWebhook(discordMessage),
    notifyTelegram(telegramMessage),
  ]);
}

/**
 * Sends a CGPS notification to every configured channel (Discord + Telegram).
 * Use this instead of calling notifyWebhook/notifyTelegram individually so
 * new notification channels only need to be added in one place.
 * @param {string} msg The message to be sent.
 * @returns {Promise}
 */
export async function notify(msg) {
  await Promise.all([
    notifyWebhook(msg),
    notifyTelegram(msg),
  ]);
}

/**
 * Fetches with retry.
 * On generic errors: retries immediately (network blips, transient errors).
 * On HTTP 429 (Cloudflare rate limit): backs off using an escalating
 * schedule (10s -> 30s -> 60s -> 90s -> 120s -> 180s, then holds at 180s) instead of a single
 * fixed wait, so the script recovers faster from short rate-limit windows
 * while still being patient enough for longer ones.
 * @param  {Parameters<typeof fetch>} args
 */
export const fetchRetry = async (...args) => {
  let attempts = 0;
  let rateLimitHits = 0;
  let response;

  // Dùng để chọn đúng nội dung thông báo lỗi: hàm này được dùng cho CẢ 2 việc
  // khác nhau - (1) gọi Cloudflare API thật (qua requestGateway), và (2) tải
  // nội dung blocklist/allowlist từ GitHub/jsdelivr (qua downloadFiles).
  // Thông báo lỗi 401/403 phải khác nhau tuỳ trường hợp, tránh gây hiểu nhầm
  // "chắc do token Cloudflare" khi thực ra là 1 URL blocklist bị chặn/rate-limit.
  const targetUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
  const isCloudflareApiCall = targetUrl.includes("api.cloudflare.com");

  // QUAN TRỌNG: Cloudflare API cần kiên nhẫn thử lại nhiều (50 lần) vì đây là
  // hành động thiết yếu (tạo/xoá list). Với 1 URL blocklist/allowlist bên
  // ngoài, việc thử tới 50 lần x tối đa 180s/lần có thể "treo" hàng giờ nếu
  // URL đó hỏng vĩnh viễn, làm cả job GitHub Actions hết giờ (timeout-minutes)
  // trước khi kịp xử lý các URL khác. Vì vậy giới hạn thấp hơn nhiều (6 lần,
  // tối đa ~5 phút) rồi bỏ qua URL đó, để không chặn toàn bộ tiến trình.
  let maxAttempts = isCloudflareApiCall ? 50 : 6;

  while (attempts < maxAttempts) {
    try {
      response = await fetch(...args);

      // QUAN TRỌNG: 304 Not Modified KHÔNG PHẢI lỗi - đây là kết quả ĐÚNG
      // và MONG MUỐN của HTTP Conditional GET (dùng ETag/Last-Modified để
      // hỏi "nguồn có gì mới không" trước khi tải toàn bộ nội dung). `response.ok`
      // của fetch() chỉ đúng cho 200-299 nên tự động coi 304 là false - phải
      // xử lý riêng ở đây để không bị coi là lỗi/bị retry.
      if (response.status === 304) {
        return response;
      }

      if (!response.ok) {
        // QUAN TRỌNG: đọc nội dung lỗi THẬT Cloudflare trả về (thường có
        // dạng {"errors":[{"code":...,"message":"..."}]}) thay vì chỉ báo
        // mã trạng thái suông. Đây là lý do thực sự tại sao request thất
        // bại (VD: "You have reached the maximum number of lists allowed
        // for your account" khi đã đủ 300 list) - trước đây bị mất hoàn
        // toàn thông tin này, chỉ thấy "Error: undefined" vô nghĩa.
        let detail = "";
        try {
          const body = await response.clone().json();
          detail = body?.errors?.map(e => e.message).join("; ") || JSON.stringify(body);
        } catch {
          try { detail = await response.clone().text(); } catch { /* ignore */ }
        }
        throw new Error(`HTTP error! Status: ${response.status}${detail ? ` - ${detail}` : ""}`);
      }

      return response;
    } catch (error) {
      attempts++;
      runStats.retryCount++;

      // 401/403 khi gọi CLOUDFLARE API = vấn đề xác thực/quyền hạn - KHÔNG
      // BAO GIỜ tự hết bằng cách thử lại, nên dừng ngay lập tức thay vì lãng
      // phí 50 lần thử. Với nguồn TẢI BÊN NGOÀI (GitHub/jsdelivr...), 403
      // thường chỉ là rate-limit/chặn tạm thời (không phải lỗi quyền hạn cố
      // định) nên vẫn cho thử lại có backoff như 429 - chỉ 401 mới dừng ngay
      // (401 từ 1 URL công khai gần như luôn nghĩa là URL sai/cần đăng nhập,
      // thử lại không giúp được gì).
      if (response && (
        (isCloudflareApiCall && (response.status === 401 || response.status === 403)) ||
        (!isCloudflareApiCall && response.status === 401)
      )) {
        let reason;
        if (isCloudflareApiCall) {
          reason = response.status === 401
            ? "401 Unauthorized: Token KHÔNG được chấp nhận (sai, rỗng, đã bị xoá/thu hồi trên Cloudflare, hoặc chưa cấu hình secret CLOUDFLARE_API_TOKEN). Đây KHÔNG phải lỗi thiếu quyền - đừng đổi sang Global API Key, hãy tạo lại Cloudflare API Token và cập nhật secret CLOUDFLARE_API_TOKEN."
            : "403 Forbidden: Token hợp lệ nhưng THIẾU QUYỀN. Vào Cloudflare Dashboard > API Tokens > sửa token, đảm bảo có quyền Account > Zero Trust > Edit.";
        } else {
          reason = `401 khi tải "${targetUrl}" - nguồn này yêu cầu xác thực hoặc URL không đúng. KHÔNG liên quan tới Cloudflare API Token. Kiểm tra lại URL này còn đúng/công khai không.`;
        }
        console.error(`Dừng ngay lập tức (không retry) - ${reason}`);
        if (isCloudflareApiCall) {
          await notify(`❌ <b>Lỗi xác thực Cloudflare (HTTP ${response.status})</b>\n${reason}`);
        }
        throw new Error(`HTTP ${response.status}: ${reason}`);
      }

      // QUAN TRỌNG: 400 Bad Request từ CHÍNH Cloudflare API (không phải
      // nguồn tải blocklist bên ngoài) hầu như luôn là lỗi CỐ ĐỊNH - cùng
      // 1 request gửi lại y hệt sẽ luôn bị từ chối y hệt (VD: đã đạt giới
      // hạn 300 list/tài khoản, payload sai định dạng...). Thử lại 50 lần
      // với y hệt request đó chỉ lãng phí thời gian và làm log dài vô ích -
      // dừng ngay, in rõ lý do thật (đã đọc ở trên) để biết chính xác cần
      // sửa gì (VD: dọn bớt list cũ, hoặc giảm số domain).
      if (response && isCloudflareApiCall && response.status === 400) {
        console.error(`Dừng ngay lập tức (không retry) - 400 Bad Request: ${error.message}`);
        throw error;
      }

      console.warn(`An error occured while making a web request: "${error}", retrying. Attempt ${attempts} of ${maxAttempts}.\nTHIS IS NORMAL IN MOST CIRCUMSTANCES. Refrain from reporting this as a bug unless the script doesn't automatically recover after several attempts.`);

      if (attempts >= maxAttempts) {
        // Send a failure alert to every configured notification channel
        // (only for Cloudflare API calls - a failed blocklist source URL is
        // reported by downloadFiles/downloadLists instead, with its own
        // clearer per-URL context).
        if (isCloudflareApiCall) {
          await notify(`❌ <b>Lỗi cập nhật</b>\nĐã xảy ra lỗi HTTP (${response ? response.status : "unknown status"}) khi gọi Cloudflare API sau ${maxAttempts} lần thử lại. Vui lòng kiểm tra log GitHub Actions để biết chi tiết.`);
        }
        throw error;
      }

      if (response && (
        response.status === RATE_LIMITING_HTTP_ERROR_CODE ||
        (!isCloudflareApiCall && response.status === 403)
      )) {
        const waitTime = CLOUDFLARE_RATE_LIMIT_BACKOFF_SCHEDULE[
          Math.min(rateLimitHits, CLOUDFLARE_RATE_LIMIT_BACKOFF_SCHEDULE.length - 1)
        ];
        rateLimitHits++;
        console.log(`Bị rate-limit (${response.status}) khi gọi "${targetUrl}" - lần thứ ${rateLimitHits}. Đợi ${waitTime / 1000}s rồi thử lại...`);
        await wait(waitTime);
      }
    }
  }
}
