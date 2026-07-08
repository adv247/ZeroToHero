import {
  ACCOUNT_EMAIL,
  ACCOUNT_ID,
  API_HOST,
  API_KEY,
  API_TOKEN,
} from "./constants.js";
import { fetchRetry } from "./utils.js";

if (!globalThis.fetch) {
  console.warn(
    "\nIMPORTANT: Your Node.js version doesn't have native fetch support and may not be supported in the future. Please update to v18 or later.\n"
  );
  // Advise what to do if running in GitHub Actions
  if (process.env.GITHUB_WORKSPACE)
    console.warn(
      "Since you're running in GitHub Actions, you should update your Actions workflow configuration to use Node v18 or higher."
    );
  // Import node-fetch since there's no native fetch in this environment
  globalThis.fetch = (await import("node-fetch")).default;
}

/**
 * Fires request to the specified URL.
 * @param {string} url The URL to which the request will be fired.
 * @param {RequestInit} options The options to be passed to `fetch`.
 * @returns {Promise}
 */
const request = async (url, options) => {
  if (!(API_TOKEN || API_KEY) || !ACCOUNT_ID) {
    throw new Error(
      "The following secrets are required: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID"
    );
  }

  const headers = API_TOKEN
    ? {
        Authorization: `Bearer ${API_TOKEN}`,
      }
    : {
        Authorization: `Bearer ${API_KEY}`,
        "X-Auth-Email": ACCOUNT_EMAIL,
        "X-Auth-Key": API_KEY,
      };

  const response = await fetchRetry(url, {
    ...options,
    headers: {
    "Content-Type": "application/json",
      ...options.headers,
      ...headers,
    },
  });

  // QUAN TRỌNG (bug thật đã sửa): trước đây biến `data` được khai báo nhưng
  // KHÔNG BAO GIỜ được gán giá trị (`let data;` rồi dùng thẳng trong catch),
  // nên mọi lỗi đều hiện "Error: undefined" - không bao giờ thấy được lý do
  // THẬT Cloudflare trả về (VD: "you have reached the maximum number of
  // lists"). Giờ luôn đọc và trả về đúng nội dung JSON thật từ Cloudflare.
  return await response.json();
};

/**
 * Fires request to the Zero Trust gateway.
 * @param {string} path The path which will be appended to the request URL.
 * @param {RequestInit} options The options to be passed to `fetch`.
 * @returns {Promise}
 */
export const requestGateway = (path, options) =>
  request(`${API_HOST}/accounts/${ACCOUNT_ID}/gateway${path}`, options);

/**
 * Normalizes a domain.
 * @param {string} value The value to be normalized.
 * @param {boolean} isAllowlisting Whether the value is to be allowlisted.
 * @returns {string}
 */
export const normalizeDomain = (value, isAllowlisting) => {
  const init = (isAllowlisting) ? value.replace("@@||", "") : value;
  const normalized = init
    .replace(/(0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+/, "")
    .replace("||", "")
    .replace("^$important", "")
    .replace("*.", "")
    .replace("^", "");

  return normalized;
};
