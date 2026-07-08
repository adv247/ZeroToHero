import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  LIST_TYPE,
  PROCESSING_FILENAME,
  RECOMMENDED_ALLOWLIST_URLS,
  RECOMMENDED_BLOCKLIST_URLS,
  RECOMMENDED_IP_BLOCKLIST_URLS,
  USER_DEFINED_ALLOWLIST_URLS,
  USER_DEFINED_BLOCKLIST_URLS,
  USER_DEFINED_IP_BLOCKLIST_URLS,
} from "./lib/constants.js";
import { downloadFiles } from "./lib/utils.js";

// Tự động loại bỏ URL bị trùng lặp y hệt (copy-paste nhầm 2 lần...) trong
// mỗi danh sách trước khi tải - tránh tải cùng 1 nguồn 2 lần vô ích.
// Giữ nguyên thứ tự xuất hiện đầu tiên.
const dedupeUrls = (urls) => [...new Set(urls.map(u => u.trim()).filter(Boolean))];

const allowlistUrls = dedupeUrls(USER_DEFINED_ALLOWLIST_URLS || RECOMMENDED_ALLOWLIST_URLS);
const blocklistUrls = dedupeUrls(USER_DEFINED_BLOCKLIST_URLS || RECOMMENDED_BLOCKLIST_URLS);
// Tính năng IP blocklist hoàn toàn tuỳ chọn: chỉ tải khi có URL cấu hình.
const ipBlocklistUrls = dedupeUrls(USER_DEFINED_IP_BLOCKLIST_URLS || RECOMMENDED_IP_BLOCKLIST_URLS);
const listType = process.argv[2];

// QUAN TRỌNG: hệ thống CHỈ dùng đúng danh sách người dùng tự cấu hình
// trong ALLOWLIST_URLS/BLOCKLIST_URLS/IP_BLOCKLIST_URLS - không có danh
// sách mặc định nào được tự động thêm vào (RECOMMENDED_* đều rỗng). In rõ
// ràng nguồn đang dùng ra log để không bao giờ có chuyện "tự nhiên xuất
// hiện domain/IP lạ" mà không biết từ đâu.
const logSource = (label, userDefined, urls, rawCount) => {
  if (userDefined) {
    const dupeNote = rawCount > urls.length ? ` (đã bỏ ${rawCount - urls.length} URL trùng lặp)` : "";
    console.log(`[${label}] Dùng ${urls.length} nguồn TỰ CẤU HÌNH${dupeNote}:`);
    urls.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
  } else if (urls.length === 0) {
    console.warn(`[${label}] ⚠️ CHƯA CẤU HÌNH - danh sách rỗng, sẽ KHÔNG có gì được thêm vào. Đây là hành vi ĐÚNG THIẾT KẾ (chỉ dùng đúng nguồn bạn tự cấu hình), không phải lỗi.`);
  }
};
logSource("ALLOWLIST_URLS", USER_DEFINED_ALLOWLIST_URLS, allowlistUrls, (USER_DEFINED_ALLOWLIST_URLS || []).length);
logSource("BLOCKLIST_URLS", USER_DEFINED_BLOCKLIST_URLS, blocklistUrls, (USER_DEFINED_BLOCKLIST_URLS || []).length);
logSource("IP_BLOCKLIST_URLS", USER_DEFINED_IP_BLOCKLIST_URLS, ipBlocklistUrls, (USER_DEFINED_IP_BLOCKLIST_URLS || []).length);

const downloadLists = async (filename, urls) => {
  const filePath = resolve(`./${filename}`);

  if (existsSync(filePath)) {
    await unlink(filePath);
  }

  // LUÔN tạo file trước, kể cả khi urls rỗng - để cf_list_create.js/
  // cf_ip_list_create.js tìm thấy file (rỗng = "không chặn gì") thay vì
  // báo lỗi "File not found" và dừng hẳn workflow. Chưa cấu hình
  // ALLOWLIST_URLS/BLOCKLIST_URLS/IP_BLOCKLIST_URLS là một lựa chọn hợp lệ,
  // không phải lỗi.
  await writeFile(filePath, "");

  if (!urls.length) return;

  console.log(`Đang tải ${urls.length} nguồn cho ${filename}...`);
  const results = await downloadFiles(filePath, urls);

  const succeeded = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);

  console.log(
    `Xong ${filename}: ${succeeded.length}/${urls.length} nguồn tải thành công.`
  );

  if (failed.length) {
    // QUAN TRỌNG: KHÔNG chặn cả bước lại chỉ vì 1 vài nguồn lỗi - list vẫn
    // được tạo/cập nhật bình thường với dữ liệu từ các nguồn tải thành
    // công. Chỉ cảnh báo THẬT RÕ RÀNG (log + biến GITHUB_OUTPUT để bước
    // sau đưa vào thông báo Discord/Telegram) để bạn luôn biết chính xác
    // nguồn nào đang thiếu, thay vì phải tự đoán hoặc bị chặn cả job.
    console.error(`⚠️ ${failed.length}/${urls.length} nguồn của ${filename} KHÔNG tải được (dữ liệu các nguồn này KHÔNG có trong kết quả), NHƯNG vẫn tiếp tục với ${succeeded.length} nguồn còn lại:`);
    failed.forEach(f => console.error(`  - ${f.url}: ${f.error}`));
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
  default:
    await Promise.all([
      downloadLists(PROCESSING_FILENAME.ALLOWLIST, allowlistUrls),
      downloadLists(PROCESSING_FILENAME.BLOCKLIST, blocklistUrls),
      // Chỉ tải nếu người dùng đã cấu hình IP_BLOCKLIST_URLS - hoàn toàn
      // tương thích ngược, không ảnh hưởng ai chưa dùng tính năng này.
      ...(ipBlocklistUrls.length
        ? [downloadLists(PROCESSING_FILENAME.IP_BLOCKLIST, ipBlocklistUrls)]
        : []),
    ]);
}
