import {
  deleteZeroTrustListsOneByOne,
  getZeroTrustLists,
} from "./lib/api.js";
import { DELETION_ENABLED } from "./lib/constants.js";
import { notify } from "./lib/utils.js";

if (!DELETION_ENABLED) {
  console.warn(
    "The list deletion step is no longer needed to update filter lists, safely skipping. To proceed with deletion to e.g. stop using CGPS, set the environment variable CGPS_DELETION_ENABLED=true and re-run the script. Exiting."
  );
  process.exit(0);
}

(async () => {
  try {
    const { result: lists } = await getZeroTrustLists();

    if (!lists) {
      console.warn(
        "No file lists found - this is not an issue if it's your first time running this script. Exiting."
      );
      return;
    }

    const cgpsLists = lists.filter(({ name }) => name.startsWith("CGPS List"));

    if (!cgpsLists.length) {
      console.warn(
        "No lists with matching name found - this is not an issue if you haven't created any filter lists before. Exiting."
      );
      return;
    }

    console.log(
      `Got ${lists.length} lists, ${cgpsLists.length} of which are CGPS lists that will be deleted.`
    );

    console.log(`Deleting ${cgpsLists.length} lists...`);

    const { deletedCount, skippedInUseCount } = await deleteZeroTrustListsOneByOne(cgpsLists);

    if (skippedInUseCount > 0) {
      await notify(
        `🗑️ Đã xoá ${deletedCount}/${cgpsLists.length} list chặn.\n` +
        `⚠️ ${skippedInUseCount} list bị BỎ QUA vì vẫn đang bám vào Gateway Policy khác (không phải lỗi - script vẫn hoàn tất bình thường). ` +
        `Vào Cloudflare Dashboard > Gateway > Policies để gỡ thủ công nếu muốn xoá dứt điểm.`
      );
    } else {
      await notify(`🗑️ Đã xoá toàn bộ ${cgpsLists.length} list chặn`);
    }
  } catch (err) {
    console.error(`❌ Xoá list KHÔNG hoàn tất: ${err.message}`);
    await notify(`❌ Xoá list KHÔNG hoàn tất\n${err.message}`);
    process.exitCode = 1;
  }
})();
