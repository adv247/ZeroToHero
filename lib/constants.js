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

// Số mục tối đa MỖI list. Theo tài liệu chính thức Cloudflare
// (developers.cloudflare.com/cloudflare-one/policies/gateway/lists/):
// "Your lists can include up to 1,000 entries for Standard plans and 5,000
// for Enterprise plans." Mặc định 1000 (đúng cho Free/Pro/Business). Nếu
// dùng gói Enterprise, đặt secret CLOUDFLARE_LIST_ITEM_SIZE=5000 để tận
// dụng đúng hạn mức thật - với LIST_COUNT_LIMIT=300 (mặc định), điều này
// nâng tổng dung lượng từ 300.000 lên tới 1.500.000 mục mà KHÔNG cần xin
// Cloudflare tăng số list, chỉ cần đúng cấu hình theo gói đang dùng.
export const LIST_ITEM_SIZE = isNaN(process.env.CLOUDFLARE_LIST_ITEM_SIZE)
  ? 1000
  : parseInt(process.env.CLOUDFLARE_LIST_ITEM_SIZE, 10);

// Giới hạn TỔNG SỐ LIST toàn tài khoản (khác với LIST_ITEM_LIMIT ở trên -
// đó là giới hạn số DOMAIN/IP, còn đây là giới hạn số LIST chứa chúng).
// Mặc định 300 khớp với gói Free/Pro/Business hiện tại của Cloudflare. Nếu
// bạn dùng gói Enterprise có hạn mức cao hơn, đặt secret
// CLOUDFLARE_LIST_COUNT_LIMIT theo đúng hạn mức thật của tài khoản - script
// sẽ dùng đúng con số đó để tính toán cắt bớt an toàn (graceful truncation),
// không còn bị ép cứng ở 300 nếu tài khoản bạn thực sự cho phép nhiều hơn.
export const LIST_COUNT_LIMIT = isNaN(process.env.CLOUDFLARE_LIST_COUNT_LIMIT)
  ? 300
  : parseInt(process.env.CLOUDFLARE_LIST_COUNT_LIMIT, 10);

// CẢNH BÁO CHỦ ĐỘNG: nếu secret CLOUDFLARE_LIST_ITEM_LIMIT lỡ bị đặt thành
// 1 số quá nhỏ (VD: "300" thay vì để trống/300000 - lỗi rất dễ gặp khi copy
// nhầm số list thay vì số domain), script sẽ ÂM THẦM dừng xử lý blocklist
// rất sớm mà log không nói rõ nguyên nhân là do cấu hình. In cảnh báo to,
// rõ ràng NGAY từ khi khởi động script để không bao giờ phải debug mò nữa.
if (process.env.CLOUDFLARE_LIST_ITEM_LIMIT && LIST_ITEM_LIMIT < LIST_ITEM_SIZE * 5) {
  console.warn(
    `⚠️⚠️⚠️ CẢNH BÁO: Secret CLOUDFLARE_LIST_ITEM_LIMIT đang được đặt là ${LIST_ITEM_LIMIT} - ` +
    `RẤT NHỎ bất thường (mặc định là 300000). Với giá trị này, script sẽ chỉ xử lý tối đa ` +
    `${LIST_ITEM_LIMIT} domain/IP rồi DỪNG LẠI SỚM dù blocklist thật có nhiều hơn - đây thường ` +
    `là nguyên nhân khiến "chỉ tạo được 1 list nhỏ dù đã tải hàng trăm nghìn dòng dữ liệu". ` +
    `Nếu đây không phải chủ đích của bạn, hãy XOÁ secret này (Settings > Secrets and variables ` +
    `> Actions) để dùng mặc định 300000, hoặc sửa lại đúng giá trị bạn muốn.`
  );
}

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
// Đúng 7 bước theo yêu cầu: 10s, 30s, 60s, 90s, 120s, 150s, 180s - từ lần
// thứ 8 trở đi giữ nguyên ở 180s.
// Tăng dần thay vì đợi cố định 1 khoảng giúp phục hồi nhanh hơn với rate-limit
// ngắn hạn (thường tự hết sau vài giây), nhưng vẫn đủ kiên nhẫn nếu bị giới
// hạn kéo dài, tránh dội liên tục vào Cloudflare API gây rate-limit nặng hơn.
export const CLOUDFLARE_RATE_LIMIT_BACKOFF_SCHEDULE = [10_000, 30_000, 60_000, 90_000, 120_000, 150_000, 180_000];
export const RATE_LIMITING_HTTP_ERROR_CODE = 429;

// Jitter (độ lệch ngẫu nhiên) cộng thêm vào MỖI lần đợi backoff, để các luồng
// bị lỗi cùng lúc (khi chạy FAST_MODE=1 với nhiều request song song) không
// đồng loạt "thức dậy" và thử lại cùng 1 thời điểm - phân tán ra, tránh tái
// nghẽn tập trung ngay sau khi hết thời gian chờ.
export const CLOUDFLARE_RATE_LIMIT_JITTER_MIN_MS = 1_000;
export const CLOUDFLARE_RATE_LIMIT_JITTER_MAX_MS = 3_000;

// Độ trễ chủ động (proactive delay) sau MỖI lần ghi (create/patch/delete)
// THÀNH CÔNG lên Cloudflare - không phải để phục hồi sau lỗi, mà để CHỦ ĐỘNG
// tránh chạm rate-limit "Gateway writes" ngay từ đầu khi tạo/xoá hàng loạt
// list (VD: full-reset tạo lại 295+ list liên tiếp). Chỉ áp dụng khi
// FAST_MODE=0 (tuần tự) - khi FAST_MODE=1 đã có giới hạn concurrency riêng.
export const CLOUDFLARE_WRITE_DELAY_MS = !isNaN(process.env.CLOUDFLARE_WRITE_DELAY_MS)
  ? parseInt(process.env.CLOUDFLARE_WRITE_DELAY_MS, 10)
  : 1_500;

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
