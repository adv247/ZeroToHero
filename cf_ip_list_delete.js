import {
  deleteZeroTrustListsOneByOne,
  getZeroTrustLists,
} from "./lib/api.js";
import { DELETION_ENABLED } from "./lib/constants.js";
import { notify } from "./lib/utils.js";

if (!DELETION_ENABLED) {
  console.warn(
    "The IP list deletion step is not needed for normal updates, safely skipping. To proceed with deletion (e.g. to stop using the IP blocklist feature), set CGPS_DELETION_ENABLED=true and re-run this script. Exiting."
  );
  process.exit(0);
}

(async () => {
  try {
    const { result: lists } = await getZeroTrustLists();

    if (!lists) {
      console.warn("No lists found. Exiting.");
      return;
    }

    const cgpsIpLists = lists.filter(({ name }) => name.startsWith("CGPS IP List"));

    if (!cgpsIpLists.length) {
      console.warn("No IP lists found - nothing to delete. Exiting.");
      return;
    }

    console.log(`Deleting ${cgpsIpLists.length} IP lists...`);

    const { deletedCount, skippedInUseCount } = await deleteZeroTrustListsOneByOne(cgpsIpLists);

    if (skippedInUseCount > 0) {
      await notify(
        `🗑️ Đã xoá ${deletedCount}/${cgpsIpLists.length} IP list.\n` +
        `⚠️ ${skippedInUseCount} IP list bị BỎ QUA vì vẫn đang bám vào Gateway Policy khác (không phải lỗi). ` +
        `Vào Cloudflare Dashboard > Gateway > Policies để gỡ thủ công nếu muốn xoá dứt điểm.`
      );
    } else {
      await notify(`🗑️ Đã xoá toàn bộ ${cgpsIpLists.length} IP list`);
    }
  } catch (err) {
    console.error(`❌ Xoá IP list KHÔNG hoàn tất: ${err.message}`);
    await notify(`❌ Xoá IP list KHÔNG hoàn tất\n${err.message}`);
    process.exitCode = 1;
  }
})();
