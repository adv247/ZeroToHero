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

  await deleteZeroTrustListsOneByOne(cgpsIpLists);
  await notify(`🗑️ Đã xoá toàn bộ ${cgpsIpLists.length} IP list`);
})();
