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

// Danh sách chặn theo dải IP/CIDR - KHÔNG có mặc định (mảng rỗng), đúng
// nguyên tắc "chỉ thêm đúng những gì người dùng tự cấu hình, không tự ý
// thêm bất kỳ IP/domain nào khác". Muốn bật tính năng này, tự đặt biến
// IP_BLOCKLIST_URLS với nguồn bạn chọn, ví dụ (KHÔNG tự động áp dụng, bạn
// phải chủ động copy dòng dưới vào IP_BLOCKLIST_URLS nếu muốn dùng):
// https://www.spamhaus.org/drop/drop.txt
// https://www.spamhaus.org/drop/edrop.txt
export const RECOMMENDED_IP_BLOCKLIST_URLS = [];

// These are the default blocklists and allowlists - CẢ HAI ĐỀU RỖNG. Trước
// đây 2 danh sách này có sẵn domain mặc định (OISD, AdAway...) để dùng ngay
// cả khi chưa cấu hình gì. Đã đổi thành RỖNG
// theo yêu cầu: hệ thống chỉ được thêm đúng domain/IP người dùng tự cấu
// hình trong ALLOWLIST_URLS/BLOCKLIST_URLS, không tự ý thêm bất kỳ nguồn
// nào khác. Nếu bạn chưa cấu hình, sẽ KHÔNG có domain nào bị chặn (và
// download_lists.js sẽ in cảnh báo rõ ràng, không âm thầm dùng danh sách lạ).

// KHÔNG tự động áp dụng - chỉ là ví dụ tham khảo, copy vào ALLOWLIST_URLS nếu muốn dùng:
// https://raw.githubusercontent.com/im-sm/Pi-hole-Torrent-Blocklist/main/all-torrent-trackres.txt (Torrent trackers)
// https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/banks.txt (Banks)
// https://raw.githubusercontent.com/Dogino/Discord-Phishing-URLs/main/official-domains.txt (Official Discord domains)
// https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/mac.txt (macOS specific)
// https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/windows.txt (Windows specific)
// https://raw.githubusercontent.com/boutetnico/url-shorteners/master/list.txt (URL shorteners)
// https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/firefox.txt (Firefox sync, add-ons, etc.)
// https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/android.txt (Android apps)
// https://raw.githubusercontent.com/TogoFire-Home/AD-Settings/main/Filters/whitelist.txt (General allowlist)
// https://raw.githubusercontent.com/DandelionSprout/AdGuard-Home-Whitelist/master/whitelist.txt (General allowlist)
// https://raw.githubusercontent.com/AdguardTeam/AdGuardSDNSFilter/master/Filters/exclusions.txt (General allowlist)
// https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/issues.txt (General allowlist)
export const RECOMMENDED_ALLOWLIST_URLS = [];

// KHÔNG tự động áp dụng - chỉ là ví dụ tham khảo, copy vào BLOCKLIST_URLS nếu muốn dùng:
// https://small.oisd.nl/
// https://adaway.org/hosts.txt
// Mạnh hơn - HaGeZi Pro++ (Wildcard Domains, CGPS tự bóc tách "*." sẵn):
// https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/pro.plus-onlydomains.txt
export const RECOMMENDED_BLOCKLIST_URLS = [];
