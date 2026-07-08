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

const allowlistUrls = USER_DEFINED_ALLOWLIST_URLS || RECOMMENDED_ALLOWLIST_URLS;
const blocklistUrls = USER_DEFINED_BLOCKLIST_URLS || RECOMMENDED_BLOCKLIST_URLS;
// Tính năng IP blocklist hoàn toàn tuỳ chọn: chỉ tải khi có URL cấu hình.
const ipBlocklistUrls = USER_DEFINED_IP_BLOCKLIST_URLS || RECOMMENDED_IP_BLOCKLIST_URLS;
const listType = process.argv[2];

// QUAN TRỌNG: hệ thống CHỈ dùng đúng danh sách người dùng tự cấu hình
// trong ALLOWLIST_URLS/BLOCKLIST_URLS/IP_BLOCKLIST_URLS - không có danh
// sách mặc định nào được tự động thêm vào (RECOMMENDED_* đều rỗng). In rõ
// ràng nguồn đang dùng ra log để không bao giờ có chuyện "tự nhiên xuất
// hiện domain/IP lạ" mà không biết từ đâu.
const logSource = (label, userDefined, urls) => {
  if (userDefined) {
    console.log(`[${label}] Dùng ${urls.length} nguồn TỰ CẤU HÌNH:`);
    urls.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
  } else if (urls.length === 0) {
    console.warn(`[${label}] ⚠️ CHƯA CẤU HÌNH - danh sách rỗng, sẽ KHÔNG có gì được thêm vào. Đây là hành vi ĐÚNG THIẾT KẾ (chỉ dùng đúng nguồn bạn tự cấu hình), không phải lỗi.`);
  }
};
logSource("ALLOWLIST_URLS", USER_DEFINED_ALLOWLIST_URLS, allowlistUrls);
logSource("BLOCKLIST_URLS", USER_DEFINED_BLOCKLIST_URLS, blocklistUrls);
logSource("IP_BLOCKLIST_URLS", USER_DEFINED_IP_BLOCKLIST_URLS, ipBlocklistUrls);

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
    console.error(`⚠️ ${failed.length} nguồn KHÔNG tải được, dữ liệu của các nguồn này KHÔNG có mặt trong ${filename}:`);
    failed.forEach(f => console.error(`  - ${f.url}: ${f.error}`));
    // Ném lỗi để job GitHub Actions hiển thị rõ trạng thái thất bại thay vì
    // báo "thành công" trong khi thực chất thiếu dữ liệu - đúng là nguyên
    // nhân của việc "báo update xong nhưng số lượng không khớp".
    throw new Error(
      `${failed.length}/${urls.length} URL trong ${filename} tải thất bại: ${failed.map(f => f.url).join(", ")}`
    );
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
