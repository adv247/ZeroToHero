import { getZeroTrustLists, upsertZeroTrustDNSRule, upsertZeroTrustIPRule, upsertZeroTrustSNIRule } from "./lib/api.js";
import { BLOCK_BASED_ON_SNI } from "./lib/constants.js";
import { notify } from "./lib/utils.js";

const { result: lists } = await getZeroTrustLists();

// Upsert DNS rules for all lists
await upsertZeroTrustDNSRule(lists, "CGPS Filter Lists");

// Optionally create a rule that matches the SNI.
// This only works for users who proxy their traffic through Cloudflare.
if (BLOCK_BASED_ON_SNI) {
  await upsertZeroTrustSNIRule(lists, "CGPS Filter Lists - SNI Based Filtering");
}

// Optionally create a Network policy blocking traffic to IP/CIDR ranges,
// but only if the IP blocklist feature is actually in use (cf_ip_list_create.js
// has created at least one "CGPS IP List" list). Fully backwards compatible -
// does nothing for setups that don't use IP_BLOCKLIST_URLS.
const ipLists = (lists || []).filter(({ name }) => name.startsWith("CGPS IP List"));
if (ipLists.length) {
  await upsertZeroTrustIPRule(ipLists, "CGPS Filter Lists - IP Based Blocking");
}

// Send a notification to the webhook
await notify("✅ Gateway Rule (DNS/SNI) đã cập nhật xong");
