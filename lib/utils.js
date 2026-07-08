import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
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
export const downloadFiles = async (filePath, urls) => {
  // Note: This function used to download files in parallel using `Promise.all`.
  // This was changed to download files sequentially to avoid rate limiting and other issues (servers don't react well to 20+ separate requests in under 1 second).
  for (const url of urls) {
    const response = await fetch(url);
    const writeStream = createWriteStream(filePath, { flags: "a" });

    await pipeline(response.body, writeStream, { end: false });
    writeStream.end("\n");
    // QUAN TRỌNG: phải chờ stream ghi xong HẲN (sự kiện "finish") trước khi
    // vòng lặp mở createWriteStream mới (flags "a") cho URL tiếp theo trên
    // CÙNG file. Trước đây không await việc này -> race condition thật sự:
    // 2 stream ghi đè/chồng lên nhau trên cùng file có thể làm MẤT dữ liệu
    // của URL trước đó (đã tái hiện và xác nhận bằng test thực tế).
    await once(writeStream, "finish");
  }
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
  let maxAttempts = 50;
  let rateLimitHits = 0;
  let response;

  while (attempts < maxAttempts) {
    try {
      response = await fetch(...args);

      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      return response;
    } catch (error) {
      attempts++;
      runStats.retryCount++;

      // 401/403 = vấn đề xác thực/quyền hạn - KHÔNG BAO GIỜ tự hết bằng cách
      // thử lại. Retry chỉ giúp với lỗi tạm thời (mạng, 429, 5xx). Việc thử
      // lại 50 lần cho 401/403 vừa lãng phí thời gian vừa dội liên tục vào
      // Cloudflare API, có thể tự gây thêm rate-limit (429) chồng lên lỗi gốc.
      // Vì vậy: dừng ngay lập tức, báo lỗi rõ ràng để người dùng sửa đúng gốc rễ.
      if (response && (response.status === 401 || response.status === 403)) {
        const reason = response.status === 401
          ? "401 Unauthorized: Token KHÔNG được chấp nhận (sai, rỗng, đã bị xoá/thu hồi trên Cloudflare, hoặc chưa cấu hình secret CLOUDFLARE_API_TOKEN). Đây KHÔNG phải lỗi thiếu quyền - đừng đổi sang Global API Key, hãy tạo lại Cloudflare API Token và cập nhật secret CLOUDFLARE_API_TOKEN."
          : "403 Forbidden: Token hợp lệ nhưng THIẾU QUYỀN. Vào Cloudflare Dashboard > API Tokens > sửa token, đảm bảo có quyền Account > Zero Trust > Edit.";
        console.error(`Dừng ngay lập tức (không retry) - ${reason}`);
        await notify(`❌ <b>Lỗi xác thực Cloudflare (HTTP ${response.status})</b>\n${reason}`);
        throw new Error(`HTTP ${response.status}: ${reason}`);
      }

      console.warn(`An error occured while making a web request: "${error}", retrying. Attempt ${attempts} of ${maxAttempts}.\nTHIS IS NORMAL IN MOST CIRCUMSTANCES. Refrain from reporting this as a bug unless the script doesn't automatically recover after several attempts.`);

      if (attempts >= maxAttempts) {
        // Send a failure alert to every configured notification channel
        await notify(`❌ <b>Lỗi cập nhật</b>\nĐã xảy ra lỗi HTTP (${response ? response.status : "unknown status"}) khi gọi Cloudflare API sau ${maxAttempts} lần thử lại. Vui lòng kiểm tra log GitHub Actions để biết chi tiết.`);
        throw error;
      }

      if (response && response.status === RATE_LIMITING_HTTP_ERROR_CODE) {
        const waitTime = CLOUDFLARE_RATE_LIMIT_BACKOFF_SCHEDULE[
          Math.min(rateLimitHits, CLOUDFLARE_RATE_LIMIT_BACKOFF_SCHEDULE.length - 1)
        ];
        rateLimitHits++;
        console.log(`Bị Cloudflare rate-limit (429) - lần thứ ${rateLimitHits}. Đợi ${waitTime / 1000}s rồi thử lại...`);
        await wait(waitTime);
      }
    }
  }
}
