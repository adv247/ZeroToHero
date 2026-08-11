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

export const LIST_ITEM_SIZE = isNaN(process.env.CLOUDFLARE_LIST_ITEM_SIZE)
  ? 1000
  : parseInt(process.env.CLOUDFLARE_LIST_ITEM_SIZE, 10);

export const LIST_COUNT_LIMIT = isNaN(process.env.CLOUDFLARE_LIST_COUNT_LIMIT)
  ? 300
  : parseInt(process.env.CLOUDFLARE_LIST_COUNT_LIMIT, 10);

if (process.env.CLOUDFLARE_LIST_ITEM_LIMIT && LIST_ITEM_LIMIT < LIST_ITEM_SIZE * 5) {
  console.warn(
    `⚠️⚠️⚠️ CẢNH BÁO: Secret CLOUDFLARE_LIST_ITEM_LIMIT đang được đặt là ${LIST_ITEM_LIMIT} - ` +
    `RẤT NHỎ bất thường (mặc định là 300000). Với giá trị này, script sẽ chỉ xử lý tối đa ` +
    `${LIST_ITEM_LIMIT} domain/IP rồi DỪNG LẠI SỚM dù blocklist thật có nhiều hơn.`
  );
}

export const API_HOST = "https://api.cloudflare.com/client/v4";
export const DRY_RUN = !!parseInt(process.env.DRY_RUN, 10);
export const DELETION_ENABLED = !!process.env.CGPS_DELETION_ENABLED;
export const BLOCK_PAGE_ENABLED = !!parseInt(process.env.BLOCK_PAGE_ENABLED, 10);
export const BLOCK_BASED_ON_SNI = !!parseInt(process.env.BLOCK_BASED_ON_SNI, 10);
export const DEBUG = !!parseInt(process.env.DEBUG, 10);
export const FAST_MODE = !!parseInt(process.env.FAST_MODE, 10);
export const FAST_MODE_CONCURRENCY = 10;

export const CLOUDFLARE_RATE_LIMIT_BACKOFF_SCHEDULE = [10_000, 30_000, 60_000, 90_000, 120_000, 150_000, 180_000];
export const RATE_LIMITING_HTTP_ERROR_CODE = 429;
export const CLOUDFLARE_RATE_LIMIT_JITTER_MIN_MS = 1_000;
export const CLOUDFLARE_RATE_LIMIT_JITTER_MAX_MS = 3_000;

export const CLOUDFLARE_WRITE_DELAY_MS = !isNaN(process.env.CLOUDFLARE_WRITE_DELAY_MS)
  ? parseInt(process.env.CLOUDFLARE_WRITE_DELAY_MS, 10)
  : 1_500;

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export const PROCESSING_FILENAME = {
  ALLOWLIST: "allowlist.txt",
  BLOCKLIST: "blocklist.txt",
  IP_BLOCKLIST: "ip_blocklist.txt",
  IP_ALLOWLIST: "ip_allowlist.txt",
  OLD_ALLOWLIST: "whitelist.csv",
  OLD_BLOCKLIST: "input.csv",
};

export const LIST_TYPE = {
  ALLOWLIST: "allowlist",
  BLOCKLIST: "blocklist",
  IP_BLOCKLIST: "ip_blocklist",
  IP_ALLOWLIST: "ip_allowlist",
};

export const USER_DEFINED_ALLOWLIST_URLS = process.env.ALLOWLIST_URLS
  ? process.env.ALLOWLIST_URLS.split("\n").filter((x) => x)
  : undefined;

export const USER_DEFINED_BLOCKLIST_URLS = process.env.BLOCKLIST_URLS
  ? process.env.BLOCKLIST_URLS.split("\n").filter((x) => x)
  : undefined;

export const USER_DEFINED_IP_BLOCKLIST_URLS = process.env.IP_BLOCKLIST_URLS
  ? process.env.IP_BLOCKLIST_URLS.split("\n").filter((x) => x)
  : undefined;

export const USER_DEFINED_IP_ALLOWLIST_URLS = process.env.IP_ALLOWLIST_URLS
  ? process.env.IP_ALLOWLIST_URLS.split("\n").filter((x) => x)
  : undefined;

export const RECOMMENDED_IP_BLOCKLIST_URLS = [];
export const RECOMMENDED_IP_ALLOWLIST_URLS = [];
export const RECOMMENDED_ALLOWLIST_URLS = [];
export const RECOMMENDED_BLOCKLIST_URLS = [];
