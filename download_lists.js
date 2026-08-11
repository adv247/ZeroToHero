import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  LIST_TYPE,
  PROCESSING_FILENAME,
  RECOMMENDED_ALLOWLIST_URLS,
  RECOMMENDED_BLOCKLIST_URLS,
  RECOMMENDED_IP_ALLOWLIST_URLS,
  RECOMMENDED_IP_BLOCKLIST_URLS,
  USER_DEFINED_ALLOWLIST_URLS,
  USER_DEFINED_BLOCKLIST_URLS,
  USER_DEFINED_IP_ALLOWLIST_URLS,
  USER_DEFINED_IP_BLOCKLIST_URLS,
} from "./lib/constants.js";
import { downloadFiles } from "./lib/utils.js";

const dedupeUrls = (urls) => [...new Set(urls.map(u => u.trim()).filter(Boolean))];

const allowlistUrls = dedupeUrls(USER_DEFINED_ALLOWLIST_URLS || RECOMMENDED_ALLOWLIST_URLS);
const blocklistUrls = dedupeUrls(USER_DEFINED_BLOCKLIST_URLS || RECOMMENDED_BLOCKLIST_URLS);
const ipBlocklistUrls = dedupeUrls(USER_DEFINED_IP_BLOCKLIST_URLS || RECOMMENDED_IP_BLOCKLIST_URLS);
const ipAllowlistUrls = dedupeUrls(USER_DEFINED_IP_ALLOWLIST_URLS || RECOMMENDED_IP_ALLOWLIST_URLS);
const listType = process.argv[2];

const logSource = (label, userDefined, urls, rawCount) => {
  if (userDefined) {
    const dupeNote = rawCount > urls.length ? ` (đã bỏ ${rawCount - urls.length} URL trùng lặp)` : "";
    console.log(`[${label}] Dùng ${urls.length} nguồn TỰ CẤU HÌNH${dupeNote}:`);
    urls.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
  } else if (urls.length === 0) {
    console.warn(`[${label}] ⚠️ CHƯA CẤU HÌNH - danh sách rỗng, sẽ KHÔNG có gì được thêm vào. Đây là hành vi ĐÚNG THIẾT KẾ, không phải lỗi.`);
  }
};
logSource("ALLOWLIST_URLS", USER_DEFINED_ALLOWLIST_URLS, allowlistUrls, (USER_DEFINED_ALLOWLIST_URLS || []).length);
logSource("BLOCKLIST_URLS", USER_DEFINED_BLOCKLIST_URLS, blocklistUrls, (USER_DEFINED_BLOCKLIST_URLS || []).length);
logSource("IP_BLOCKLIST_URLS", USER_DEFINED_IP_BLOCKLIST_URLS, ipBlocklistUrls, (USER_DEFINED_IP_BLOCKLIST_URLS || []).length);
logSource("IP_ALLOWLIST_URLS", USER_DEFINED_IP_ALLOWLIST_URLS, ipAllowlistUrls, (USER_DEFINED_IP_ALLOWLIST_URLS || []).length);

const downloadLists = async (filename, urls) => {
  const filePath = resolve(`./${filename}`);

  if (existsSync(filePath)) {
    await unlink(filePath);
  }

  await writeFile(filePath, "");

  if (!urls.length) return;

  console.log(`Đang tải ${urls.length} nguồn cho ${filename}...`);
  const results = await downloadFiles(filePath, urls);

  const succeeded = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);

  console.log(`Xong ${filename}: ${succeeded.length}/${urls.length} nguồn tải thành công.`);

  if (failed.length) {
    console.error(`⚠️ ${failed.length}/${urls.length} nguồn của ${filename} KHÔNG tải được, NHƯNG vẫn tiếp tục với ${succeeded.length} nguồn còn lại:`);
    failed.forEach(f => console.error(`   - ${f.url}: ${f.error}`));
  }
};

switch (listType) {
  case LIST_TYPE.ALLOWLIST: {
    await downloadLists(PROCESSING_FILENAME.ALLOWLIST, allowlistUrls);
    break;
  }
  case LIST_TYPE.BLOCKLIST: {
    await downloadLists(PROCESSING_FILENAME.BLOCKLIST, blocklistUrls);
    break;
  }
  case LIST_TYPE.IP_BLOCKLIST: {
    if (ipBlocklistUrls.length) {
      await downloadLists(PROCESSING_FILENAME.IP_BLOCKLIST, ipBlocklistUrls);
    } else {
      console.log("IP_BLOCKLIST_URLS chưa được cấu hình, bỏ qua tải IP blocklist.");
    }
    break;
  }
  case LIST_TYPE.IP_ALLOWLIST: {
    if (ipAllowlistUrls.length) {
      await downloadLists(PROCESSING_FILENAME.IP_ALLOWLIST, ipAllowlistUrls);
    } else {
      console.log("IP_ALLOWLIST_URLS chưa được cấu hình, bỏ qua tải IP allowlist.");
    }
    break;
  }
  default:
    await Promise.all([
      downloadLists(PROCESSING_FILENAME.ALLOWLIST, allowlistUrls),
      downloadLists(PROCESSING_FILENAME.BLOCKLIST, blocklistUrls),
      ...(ipBlocklistUrls.length
        ? [downloadLists(PROCESSING_FILENAME.IP_BLOCKLIST, ipBlocklistUrls)]
        : []),
      ...(ipAllowlistUrls.length
        ? [downloadLists(PROCESSING_FILENAME.IP_ALLOWLIST, ipAllowlistUrls)]
        : []),
    ]);
}
