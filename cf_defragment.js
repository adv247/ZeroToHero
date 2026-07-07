import {
  defragmentZeroTrustLists,
  getZeroTrustLists,
  upsertZeroTrustDNSRule,
  upsertZeroTrustSNIRule,
  upsertZeroTrustIPRule,
  deleteZeroTrustListsOneByOne
} from "./lib/api.js";
import { BLOCK_BASED_ON_SNI } from "./lib/constants.js";
import { notifySyncReport, runStats, setGithubOutput } from "./lib/utils.js";

/**
 * Defragments one "family" of lists (domain or IP), rewrites its rule(s),
 * and deletes any lists left empty by the defragmentation.
 * @param {Object} options
 * @param {string} options.prefix List name prefix, e.g. "CGPS List" or "CGPS IP List".
 * @param {(lists: object[]) => Promise<void>} options.upsertRules Callback that rewrites the rule(s) using the non-empty lists.
 * @param {string} options.label Human-readable label for logging/notifications.
 */
async function defragmentFamily({ prefix, upsertRules, label }) {
  const { emptyLists, nonEmptyLists, stats } = await defragmentZeroTrustLists({ prefix });

  if (emptyLists.length > 0) {
    console.log(`[${label}] Updating rules...`);
    await upsertRules(nonEmptyLists);

    console.log(`[${label}] Deleting empty lists...`);
    await deleteZeroTrustListsOneByOne(emptyLists);
  }

  console.log(`[${label}] Defragmented ${stats.chunks} lists into ${stats.assignedLists} lists`);
  console.log(`[${label}] Patches made to ${stats.patches} lists, moving ${stats.entriesToMove} entries`);

  if (emptyLists.length > 0) {
    console.log(`[${label}] Updated rules using ${stats.nonEmptyLists} lists`);
    console.log(`[${label}] Deleted ${stats.emptyLists} empty lists`);
  }

  return stats;
}

// --- Domain lists (always runs, same as before) ---
const domainStats = await defragmentFamily({
  prefix: "CGPS List",
  label: "Domain",
  upsertRules: async (nonEmptyLists) => {
    await upsertZeroTrustDNSRule(nonEmptyLists, "CGPS Filter Lists");
    // Optionally create a rule that matches the SNI.
    // This only works for users who proxy their traffic through Cloudflare.
    if (BLOCK_BASED_ON_SNI) {
      await upsertZeroTrustSNIRule(nonEmptyLists, "CGPS Filter Lists - SNI Based Filtering");
    }
  },
});

// --- IP lists (only runs if the IP blocklist feature is actually in use) ---
const { result: allListsBeforeIp } = await getZeroTrustLists();
const hasIpLists = (allListsBeforeIp || []).some(({ name }) => name.startsWith("CGPS IP List"));

let ipStats = null;
if (hasIpLists) {
  ipStats = await defragmentFamily({
    prefix: "CGPS IP List",
    label: "IP",
    upsertRules: async (nonEmptyLists) => {
      await upsertZeroTrustIPRule(nonEmptyLists, "CGPS Filter Lists - IP Based Blocking");
    },
  });
}

const executionTimeMs = Date.now() - runStats.startedAt;
const { result: allListsAfter } = await getZeroTrustLists();
const totalAccountListsCount = allListsAfter?.length ?? (domainStats.assignedLists + (ipStats?.assignedLists || 0));

setGithubOutput("domain_current_lists", domainStats.assignedLists);
setGithubOutput("domain_deleted_lists", domainStats.emptyLists);
if (ipStats) {
  setGithubOutput("ip_current_lists", ipStats.assignedLists);
  setGithubOutput("ip_deleted_lists", ipStats.emptyLists);
}
setGithubOutput("total_account_lists", totalAccountListsCount);
setGithubOutput("execution_time", `${Math.round(executionTimeMs / 1000)}s`);
setGithubOutput("retry_count", runStats.retryCount);

// Send one combined report per family. Counts only - no domain/IP values
// are ever included in notifications.
await notifySyncReport({
  label: "Domain (Defragment)",
  totalItems: domainStats.chunks * 1000, // approximate, for display only
  currentListsCount: domainStats.assignedLists,
  createdListsCount: 0,
  patchedListsCount: domainStats.patches,
  deletedListsCount: domainStats.emptyLists,
  totalAccountListsCount,
  executionTimeMs,
});

if (ipStats) {
  await notifySyncReport({
    label: "IP (Defragment)",
    totalItems: ipStats.chunks * 1000,
    currentListsCount: ipStats.assignedLists,
    createdListsCount: 0,
    patchedListsCount: ipStats.patches,
    deletedListsCount: ipStats.emptyLists,
    totalAccountListsCount,
    executionTimeMs,
  });
}
