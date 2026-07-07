import dotenv from "dotenv";

dotenv.config();

if (process.env.CLOUDFLARE_API_KEY) {
  console.warn(
    "Using Global API Key is very risky for your Cloudflare account. It is strongly recommended to create an API Token with scoped permissions instead."
  );
}

export const API_KEY = process.env.CLOUDFLARE_API_KEY;

export const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

export const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;

export const ACCOUNT_EMAIL = process.env.CLOUDFLARE_ACCOUNT_EMAIL;

export const LIST_ITEM_LIMIT = isNaN(process.env.CLOUDFLARE_LIST_ITEM_LIMIT)
  ? 300000
  : parseInt(process.env.CLOUDFLARE_LIST_ITEM_LIMIT, 10);

export const LIST_ITEM_SIZE = 1000;

export const API_HOST = "https://api.cloudflare.com/client/v4";

export const DRY_RUN = !!parseInt(process.env.DRY_RUN, 10);

export const DELETION_ENABLED = !!process.env.CGPS_DELETION_ENABLED;

export const BLOCK_PAGE_ENABLED = !!parseInt(process.env.BLOCK_PAGE_ENABLED, 10);

export const BLOCK_BASED_ON_SNI = !!parseInt(process.env.BLOCK_BASED_ON_SNI, 10);

export const DEBUG = !!parseInt(process.env.DEBUG, 10);

// FAST_MODE=1: gửi các request PATCH/POST/DELETE/GET tới Cloudflare API
// đồng thời (song song, giới hạn bởi FAST_MODE_CONCURRENCY) thay vì tuần tự.
// FAST_MODE=0 (mặc định): giữ hành vi cũ, an toàn tuyệt đối, tuần tự từng request.
// Dùng FAST_MODE=1 khi bạn có nhiều thay đổi (nhiều list cần patch/tạo) và
// muốn rút ngắn thời gian chạy workflow đáng kể.
export const FAST_MODE = !!parseInt(process.env.FAST_MODE, 10);

// Số lượng request chạy đồng thời tối đa khi FAST_MODE=1.
// Cloudflare giới hạn 1200 request / 5 phút (~4 request/giây trung bình bền vững):
// https://developers.cloudflare.com/fundamentals/api/reference/limits/
// Concurrency=10 đủ nhanh nhưng vẫn để dư khoảng cách an toàn.
// fetchRetry() vẫn tự lùi lại (backoff tăng dần 10s->30s->60s->90s->120s->180s) khi gặp lỗi 429, nên đây chỉ là lớp
// tăng tốc, không phải lớp an toàn duy nhất chống rate limit.
export const FAST_MODE_CONCURRENCY = 10;

// Lịch trình lùi lại (backoff) khi gặp lỗi 429 (rate limit) từ Cloudflare.
// Lần dính rate-limit thứ 1: 10s, thứ 2: 30s, thứ 3: 60s, thứ 4: 90s,
// thứ 5: 120s, từ thứ 6 trở đi giữ ở 180s.
// Tăng dần thay vì đợi cố định 1 khoảng giúp phục hồi nhanh hơn với rate-limit
// ngắn hạn (thường tự hết sau vài giây), nhưng vẫn đủ kiên nhẫn nếu bị giới
// hạn kéo dài, tránh dội liên tục vào Cloudflare API gây rate-limit nặng hơn.
export const CLOUDFLARE_RATE_LIMIT_BACKOFF_SCHEDULE = [10_000, 30_000, 60_000, 90_000, 120_000, 180_000];
export const RATE_LIMITING_HTTP_ERROR_CODE = 429;

// Thông báo qua Telegram Bot (tuỳ chọn). Cần tạo bot qua @BotFather để lấy
// TELEGRAM_BOT_TOKEN, và lấy TELEGRAM_CHAT_ID (chat cá nhân, group hoặc channel).
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export const PROCESSING_FILENAME = {
  ALLOWLIST: "allowlist.txt",
  BLOCKLIST: "blocklist.txt",
  IP_BLOCKLIST: "ip_blocklist.txt",
  OLD_ALLOWLIST: "whitelist.csv",
  OLD_BLOCKLIST: "input.csv",
};

export const LIST_TYPE = {
  ALLOWLIST: "allowlist",
  BLOCKLIST: "blocklist",
  IP_BLOCKLIST: "ip_blocklist",
};

export const USER_DEFINED_ALLOWLIST_URLS = process.env.ALLOWLIST_URLS
  ? process.env.ALLOWLIST_URLS.split("\n").filter((x) => x)
  : undefined;

export const USER_DEFINED_BLOCKLIST_URLS = process.env.BLOCKLIST_URLS
  ? process.env.BLOCKLIST_URLS.split("\n").filter((x) => x)
  : undefined;

// Danh sách chặn theo dải IP/CIDR (tính năng tuỳ chọn, tắt mặc định).
// Mỗi dòng 1 URL trỏ tới 1 file chứa IP/CIDR (mỗi dòng 1 địa chỉ, ví dụ các
// feed như Spamhaus DROP/EDROP, FireHOL, blocklist.de). Đặt vào biến môi
// trường IP_BLOCKLIST_URLS (khuyến nghị lưu dạng Secret, không phải Variable).
export const USER_DEFINED_IP_BLOCKLIST_URLS = process.env.IP_BLOCKLIST_URLS
  ? process.env.IP_BLOCKLIST_URLS.split("\n").filter((x) => x)
  : undefined;

// Danh sách chặn theo dải IP/CIDR mặc định. Dùng các feed công khai, uy tín,
// cập nhật thường xuyên (Spamhaus DROP/EDROP - mạng lưới IP bị chiếm dụng bởi
// tội phạm mạng/spam, không có false-positive đáng kể). Tính năng vẫn hoàn
// toàn tuỳ chọn: chỉ thực sự tải khi bạn chưa đặt IP_BLOCKLIST_URLS, và bạn
// có thể tắt hẳn bằng cách đặt IP_BLOCKLIST_URLS="" (rỗng) - xem cf_ip_list_create.js.
export const RECOMMENDED_IP_BLOCKLIST_URLS = [
  // Spamhaus DROP (Don't Route Or Peer) - mạng lưới IP bị tội phạm mạng chiếm dụng hoàn toàn
  "https://www.spamhaus.org/drop/drop.txt",
  // Spamhaus EDROP - mở rộng của DROP, cùng tiêu chí
  "https://www.spamhaus.org/drop/edrop.txt",
];

// These are the default blocklists and allowlists that are used by the script if the user doesn't provide any URLs by themselves.
// The files are dynamically fetched from the internet, therefore it's important to choose only the most reliable sources.
// Commented out lists are subject to removal.

// You can have an unlimited number of allowlists, unlike blocklists.
export const RECOMMENDED_ALLOWLIST_URLS = [
  // Torrent trackers
  "https://raw.githubusercontent.com/im-sm/Pi-hole-Torrent-Blocklist/main/all-torrent-trackres.txt",
  // Banks
  "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/banks.txt",
  // Official Discord domains
  "https://raw.githubusercontent.com/Dogino/Discord-Phishing-URLs/main/official-domains.txt",
  // macOS specific
  "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/mac.txt",
  // Windows specific
  "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/windows.txt",
  // URL shorteners
  "https://raw.githubusercontent.com/boutetnico/url-shorteners/master/list.txt",
  // Firefox sync, add-ons, etc.
  "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/firefox.txt",
  // Android apps
  "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/android.txt",

  // General allowlists
  "https://raw.githubusercontent.com/TogoFire-Home/AD-Settings/main/Filters/whitelist.txt",
  "https://raw.githubusercontent.com/DandelionSprout/AdGuard-Home-Whitelist/master/whitelist.txt",
  "https://raw.githubusercontent.com/AdguardTeam/AdGuardSDNSFilter/master/Filters/exclusions.txt",
  "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/issues.txt",
  // Uncomment the line below to use OISD's most commmonly whitelisted list
  // https://local.oisd.nl/extract/commonly_whitelisted.php,
];

// The default blocklist settings are optimized for performance while still blocking a lot.
// Adding too many blocklists may slow down DNS response times and thus your internet speed.
// If you'd like to use something larger and more aggressive, consider HaGeZi's Pro++ list
// (https://github.com/hagezi/dns-blocklists#proplus) - a Wildcard Domains list, ~130-190k
// entries. CGPS already strips the "*." wildcard prefix automatically (see normalizeDomain
// in lib/helpers.js), so this list works out of the box. To enable it, set BLOCKLIST_URLS
// (as a Secret, not a Variable) to include this line:
// https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/pro.plus-onlydomains.txt
// Lighter alternative: hagezi's Multi LIGHT:
// https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/light.txt
export const RECOMMENDED_BLOCKLIST_URLS = [
  "https://small.oisd.nl/",
  // Only blocks mobile ads and analytics. Very tiny; comment the rest out and only use this one for the absolute best performance.
  "https://adaway.org/hosts.txt",
];
