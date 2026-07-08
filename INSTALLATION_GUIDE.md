# CGPS (Cloudflare Gateway Pi-hole Scripts) — Full Installation Guide

*(Bản tiếng Việt đầy đủ: xem [HUONG_DAN_CAI_DAT.md](./HUONG_DAN_CAI_DAT.md))*

This document walks you through installing this project **from scratch**, as a fully new and independent repository with no dependency on any other repo. Follow the steps in order. (The "create a new GitHub repo" step is placed at the **very end** - see [section 18](#18-create-a-new-github-repo)).

---

## Table of contents

1. [Get a Cloudflare API Token (Least Privilege)](#1-get-a-cloudflare-api-token-least-privilege)
2. [Configure required Secrets](#2-configure-required-secrets)
3. [Configure block/allow lists (Variable) - How it works in detail](#3-configure-blockallow-lists-variable---how-it-works-in-detail)
4. [Enable IP/CIDR blocking (optional)](#4-enable-ipcidr-blocking-optional)
5. [Configure Telegram notifications (optional)](#5-configure-telegram-notifications-optional)
6. [Create a GitHub App for a "never-expiring" token (recommended)](#6-create-a-github-app-for-a-never-expiring-token-recommended)
7. [Configure GPG commit signing (optional)](#7-configure-gpg-commit-signing-optional)
8. [Enable Workflow permissions](#8-enable-workflow-permissions)
9. [Protect the main branch (Branch Protection)](#9-protect-the-main-branch-branch-protection)
10. [Enable Secret Scanning](#10-enable-secret-scanning)
11. [Enable Dependabot Auto-merge and merge notifications](#11-enable-dependabot-auto-merge-and-merge-notifications)
12. [Run it for the first time](#12-run-it-for-the-first-time)
13. [Full Secrets/Variables reference table](#13-full-secretsvariables-reference-table)
14. [Optimizations for stable, reliable runs](#14-optimizations-for-stable-reliable-runs)
15. [Essential security measures](#15-essential-security-measures)
16. [Troubleshooting](#16-troubleshooting)
17. [Enterprise 24/7 hardening](#17-enterprise-247-hardening)
18. [Create a new GitHub repo](#18-create-a-new-github-repo)

---

## 1. Get a Cloudflare API Token (Least Privilege)

**Never use the Global API Key.** Follow the principle of least privilege:

1. Log into the [Cloudflare Dashboard](https://dash.cloudflare.com/) → top-right avatar → **My Profile** → **API Tokens**.
2. Click **Create Token** → **Create Custom Token**.
3. Name it: `CGPS-ZeroTrust-Bot`.
4. Under **Permissions**, add exactly one row:
   - `Account` → `Zero Trust` → `Edit`

   Do not add any other permission (no DNS, no Firewall, no Access).
5. Under **Account Resources**: select your specific Cloudflare account (not "All accounts").
6. (Optional, if your plan supports it) **Client IP Address Filtering**: leave empty — GitHub-hosted runner IP ranges are huge and change constantly, so restricting by IP here is impractical and doesn't add meaningful security (see section [15](#15-essential-security-measures) for a more effective alternative).
7. Click **Continue to summary** → **Create Token**.
8. **Copy the token immediately** (shown only once).
9. Get your **Account ID**: on the Dashboard home page, right column, "Account ID" field — copy it.

---

## 2. Configure required Secrets

On GitHub → your repo → **Settings** → **Secrets and variables** → **Actions** → **Secrets** tab → **New repository secret**:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | The token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | The Account ID from step 1 |

---

## 3. Configure block/allow lists (Variable) - How it works in detail

`ALLOWLIST_URLS`, `BLOCKLIST_URLS`, `IP_BLOCKLIST_URLS`, and `FAST_MODE` are configured as **Variables** (not Secrets) — so you can easily view and edit them directly in Settings without re-entering a "hidden" value each time. These are public blocklist URLs (links to GitHub raw files), not sensitive data like tokens or passwords.

### How it works

- Each variable is a **list of URLs, one per line** (no commas, no semicolons - a newline is all that's needed).
- The code reads it with `process.env.BLOCKLIST_URLS.split("\n").filter(x => x)` (see `lib/constants.js`) - blank lines are automatically skipped, no other special formatting required.
- `download_lists.js` downloads every URL in the list and merges them into a single file (`blocklist.txt`/`allowlist.txt`/`ip_blocklist.txt`), which `cf_list_create.js`/`cf_ip_list_create.js` then processes further (deduplication, invalid-domain filtering, allowlist matching, etc.).
- **If left empty, the system blocks NO domains at all** (no default list is ever used automatically) — this is an intentional design choice: guaranteeing "only ever add what you explicitly configured, never silently add unfamiliar domains/IPs". Logs and notifications will clearly show a "NOT CONFIGURED" warning if left empty, so there's never a mystery about where an unfamiliar domain came from.

### How to create the Variable

1. Go to **Settings** → **Secrets and variables** → **Actions** → the **Variables** tab (not Secrets) → **New repository variable**.
2. Create variable `BLOCKLIST_URLS`, pasting the URL list in the correct format (one per line), full example:
   ```
   https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/pro-onlydomains.txt
   https://raw.githubusercontent.com/adv247/IOS/master/ZLBlock
   https://raw.githubusercontent.com/BlockAdsRouter/Ads/main/NoxADB
   https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/popupads-onlydomains.txt
   https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/fake-onlydomains.txt
   https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/gambling-only/hosts
   https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/native.amazon-onlydomains.txt
   ```
   > Note: HaGeZi Pro++/Pro in Wildcard Domains format works well with CGPS since the code automatically strips the `*.` prefix. If a source ever blocks a legitimate domain, add that domain to `ALLOWLIST_URLS` (or maintain your own allowlist file for exceptions).
3. Create variable `ALLOWLIST_URLS` the same way (if you need your own allowlist on top of the defaults) - same format, one URL per line.
4. Create variable `FAST_MODE`, value `1` (faster, concurrent) or `0`/empty (sequential, default).

### 🎯 Recommended combo: Domain + IP (one-time copy-paste)

**Variable `BLOCKLIST_URLS`** (the sample domain list above, ready to use as-is).

**Variable `IP_BLOCKLIST_URLS`** (blocking known-malicious IP ranges - see [section 4](#4-enable-ipcidr-blocking-optional)):
```
https://www.spamhaus.org/drop/drop.txt
https://www.spamhaus.org/drop/edrop.txt
```

With this combo, every run of `update-filter-lists.yml` syncs **two fully separate list families**: `CGPS List - Chunk N` (domains) and `CGPS IP List - Chunk N` (IP/CIDR), along with two corresponding rules (DNS rule + Network rule), completely independent of each other.

---

## 4. Enable IP/CIDR blocking (optional)

A new feature, **fully separate** from the domain blocklist — uses a Gateway Network Policy (`net.dst.ip`), with its own list family "CGPS IP List".

1. Prepare one or more trusted IP/CIDR feeds, e.g.:
   - Spamhaus DROP: `https://www.spamhaus.org/drop/drop.txt`
   - Spamhaus EDROP: `https://www.spamhaus.org/drop/edrop.txt`
   - FireHOL Level 1: `https://raw.githubusercontent.com/firehol/blocklist-ipsets/master/firehol_level1.netset`
2. Create a **Variable** (Settings → Secrets and variables → Actions → the **Variables** tab) named `IP_BLOCKLIST_URLS`, one URL per line - same format as `BLOCKLIST_URLS` in section 3:
   ```
   https://www.spamhaus.org/drop/drop.txt
   https://raw.githubusercontent.com/firehol/blocklist-ipsets/master/firehol_level1.netset
   ```
3. Nothing else to do — `download_lists.js`, `cf_ip_list_create.js`, and `cf_gateway_rule_create.js` automatically detect this variable and enable the feature.
4. Leaving `IP_BLOCKLIST_URLS` empty: the feature is fully disabled and has zero effect on the existing domain blocklist (verified by testing).
5. **Good to know**: the IP list uses a Gateway Network Policy (filter `l4`) — different from Cloudflare's separate "Cloudflare Network Firewall" product (Enterprise-only). This Network Policy is available on standard Zero Trust plans (Free/Pro/Business), the same tier that already supports CGPS's existing SNI-filtering feature.

---

## 5. Configure Telegram notifications (optional)

1. Open Telegram, find **@BotFather** → send `/newbot` → name it → get a **Token** (looks like `123456:ABC-DEF...`).
2. Get your **Chat ID**:
   - Personal chat: find **@userinfobot** → `/start` → copy the numeric ID.
   - Group: add the bot to the group → send any message → visit `https://api.telegram.org/bot<TOKEN>/getUpdates` → find `"chat":{"id": ...}`.
3. Go to **Settings** → **Secrets and variables** → **Actions** → the **Secrets** tab, create:
   - `TELEGRAM_TOKEN` = bot token
   - `TELEGRAM_TO` = chat ID
4. From the next run onward, every workflow will automatically send status updates (domain count, IP count, list count, Node.js version) and error alerts via Telegram. For Dependabot specifically: you'll get a "🤖 Dependabot successfully upgraded the system!" message right when a PR actually finishes merging (see [section 11](#11-enable-dependabot-auto-merge-and-merge-notifications)).

---

## 6. Create a GitHub App for a "never-expiring" token (recommended)

Solves the problem of permanently expiring tokens — the generated token lives for 1 hour and is regenerated automatically on every run.

1. GitHub → avatar → **Settings** → bottom of the left menu → **Developer settings** → **GitHub Apps** → **New GitHub App**.
2. Fill in:
   - **GitHub App name**: e.g. `zerotrust-sync-bot-2026`
   - **Homepage URL**: your repo's link
   - **Webhook**: uncheck **Active**
3. Under **Permissions** → **Repository permissions** → **Contents** → **Read and write**.
4. Scroll down → keep **Only on this account** → **Create GitHub App**.
5. Copy the **App ID** (shown right below the app name).
6. Scroll to **Private keys** → **Generate a private key** → a `.pem` file downloads.
7. Left menu → **Install App** → **Install** → choose **Only select repositories** → select your repo → **Install**.
8. Go to **Settings** → **Secrets and variables** → **Actions** → **Secrets**, create:
   - `APP_ID` = the App ID you copied
   - `APP_PRIVATE_KEY` = the full contents of the `.pem` file (open with Notepad, copy everything)
9. The `keepalive-update.yml` workflow is already configured to automatically use this App if both secrets exist.

**What if you skip this step?** The workflow automatically falls back to `BOT_PAT_TOKEN` (if set), then to the default `GITHUB_TOKEN` — everything still works, you just lose the "never-expiring token" benefit.

---

## 7. Configure GPG commit signing (optional)

So automated commits (updating `.node-version`) get the green **Verified** badge.

1. On your personal machine, generate a GPG key (if you don't have one):
   ```bash
   gpg --full-generate-key
   # Choose RSA, 4096 bits, no expiration (or as you prefer)
   ```
2. Get the key ID:
   ```bash
   gpg --list-secret-keys --keyid-format=long
   ```
3. Export the private key:
   ```bash
   gpg --armor --export-secret-key <KEY_ID>
   ```
4. Go to your personal GitHub → **Settings** → **SSH and GPG keys** → **New GPG key** → export the **public** key (`gpg --armor --export <KEY_ID>`) and paste it there (so GitHub recognizes the signature).
5. Go to your repo → **Settings** → **Secrets and variables** → **Actions** → **Secrets**, create:
   - `GPG_PRIVATE_KEY` = the private key content from step 3
   - `GPG_PASSPHRASE` = the passphrase you set when creating the key
6. Skipping this step: commits still work fine, they just won't have the Verified badge.

---

## 8. Enable Workflow permissions

**Settings** → **Actions** → **General** → scroll to **Workflow permissions** → select **Read and write permissions** → **Save**.

Required so `stefanzweifel/git-auto-commit-action` can push the `.node-version` commit.

---

## 9. Protect the main branch (Branch Protection)

**Settings** → **Branches** → **Add branch protection rule**:

1. **Branch name pattern**: `main`
2. Check **Require a pull request before merging** (recommended, unless you want the bot to push directly — see note below).
3. Check **Require status checks to pass before merging** → select relevant CI jobs (if any).
4. Check **Require signed commits** (if you completed section 7, GPG).
5. **Do not allow bypassing the above settings**: **leave unchecked**, or add an exception for your bot/App under **Allow specified actors to bypass required pull requests** — otherwise the `keepalive-update.yml` workflow won't be able to push the `.node-version` commit directly to `main`.

> Practical note: if you strictly require a pull request for every change including the bot's, the automated `.node-version` update workflow will fail to push. The simplest setup for a personal repo: **don't** enable "Require pull request", only enable "Require signed commits" + give your bot's GitHub App/PAT direct push rights.

---

## 10. Enable Secret Scanning

**Settings** → **Code security and analysis**:
- **Secret scanning**: **Enable**
- **Push protection**: **Enable** (blocks a commit containing a plain-text secret before it can even be pushed)

Free for Public repos. Private repos need GitHub Advanced Security (paid) or an open-source alternative like [gitleaks](https://github.com/gitleaks/gitleaks) run in its own workflow if needed.

---

## 11. Enable Dependabot Auto-merge and merge notifications

1. **Settings** → **General** → scroll to **Pull Requests** → check **Allow auto-merge**.
2. The `.github/dependabot.yml` and `.github/workflows/dependabot-auto-merge.yml` files are already included — nothing else to do. Starting next week, Dependabot will open PRs upgrading GitHub Actions/npm packages.
3. **The full pipeline is already wired up:**
   - **Patch/minor** PRs → auto-merge is enabled automatically (`gh pr merge --auto --squash`), GitHub merges it once every status check passes.
   - **Major** PRs → labeled `needs-manual-review`, not auto-merged, for you to review yourself.
   - **The instant a PR actually finishes merging** (whether automatically or by hand) → the `notify-merged` job sends a Discord + Telegram message: "🤖 Dependabot successfully upgraded the system!" including the package name, update type, and PR link. This fires exactly when the merge completes (`pull_request: closed` + `merged == true`), not just when auto-merge is "enabled".

---

## 12. Run it for the first time

1. Go to the **Actions** tab on GitHub → select the **Update Filter Lists** workflow → **Run workflow** → choose the `main` branch → **Run workflow**.
2. Watch the log. The first run takes a few minutes since it has to create every list from scratch.
3. If Telegram is configured, you'll receive a message with the result (domain count, list count, Node.js version), or an error alert if something failed.
4. After it finishes, check the Cloudflare Dashboard → **Zero Trust** → **Gateway** → **Lists** to confirm the `CGPS List - Chunk N` lists (and `CGPS IP List - Chunk N` if you enabled IP blocking) have appeared.
5. Also run the **Keepalive & Node Version Update** workflow once to verify GitHub App/GPG/Telegram are all working correctly.

---

## 13. Full Secrets/Variables reference table

| Name | Type | Required? | Notes |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Secret | ✅ | Zero Trust Edit-only |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | ✅ | |
| `CLOUDFLARE_LIST_ITEM_LIMIT` | Secret | ❌ | Defaults to 300000 |
| `ALLOWLIST_URLS` | Variable | ❌ | One URL per line, no commas - see [section 3](#3-configure-blockallow-lists-variable---how-it-works-in-detail) |
| `BLOCKLIST_URLS` | Variable | ❌ | One URL per line, no commas - see [section 3](#3-configure-blockallow-lists-variable---how-it-works-in-detail) |
| `IP_BLOCKLIST_URLS` | Variable | ❌ | Enables IP/CIDR blocking - see [section 4](#4-enable-ipcidr-blocking-optional) |
| `BLOCK_PAGE_ENABLED` | **Secret** | ❌ | `1`/`0` |
| `BLOCK_BASED_ON_SNI` | **Secret** | ❌ | `1`/`0` |
| `FAST_MODE` | Variable | ❌ | `1` = faster/concurrent, `0` = sequential (default) |
| `DISCORD_WEBHOOK_URL` | Secret | ❌ | |
| `TELEGRAM_TOKEN` | Secret | ❌ | Bot token |
| `TELEGRAM_TO` | Secret | ❌ | Chat ID |
| `PING_URL` | Secret | ❌ | Healthcheck (e.g. healthchecks.io) |
| `APP_ID` | Secret | ❌ (recommended) | GitHub App ID |
| `APP_PRIVATE_KEY` | Secret | ❌ (recommended) | `.pem` file content |
| `BOT_PAT_TOKEN` | Secret | ❌ | Fallback if not using a GitHub App |
| `GPG_PRIVATE_KEY` / `GPG_PASSPHRASE` | Secret | ❌ | Verified commit badge |

> **Why are these 4 Variables while `BLOCK_PAGE_ENABLED`/`BLOCK_BASED_ON_SNI` stay Secrets?** `ALLOWLIST_URLS`/`BLOCKLIST_URLS`/`IP_BLOCKLIST_URLS`/`FAST_MODE` are values you'll **frequently review and edit** (adding/removing blocklist sources, toggling speed), so Variables are more convenient; a Secret's value is hidden once saved (you'd have to re-enter it from scratch every time), which is inconvenient for something you check/change often. `BLOCK_PAGE_ENABLED`/`BLOCK_BASED_ON_SNI` rarely change once set, so they stay Secrets for good measure. Neither choice affects the system's actual security (these aren't tokens/passwords) — the only real difference is that a Variable's value is visible when you look at it again in Settings, a Secret's isn't.

---

## 14. Optimizations for stable, reliable runs

### Fighting Cloudflare rate limits (in detail)

- **Smart retry with escalating backoff**: whenever Cloudflare returns HTTP 429 (rate limit), the script does **not** wait a fixed amount of time — it escalates: 1st hit waits **10 seconds**, 2nd hit **30 seconds**, 3rd hit **60 seconds**, 4th hit **90 seconds**, 5th hit **120 seconds**, from the 6th hit onward it holds at **180 seconds** (defined in `lib/constants.js` → `CLOUDFLARE_RATE_LIMIT_BACKOFF_SCHEDULE`). Verified by an actual test: two consecutive 429s → exactly 40s total wait (10s+30s) before the next attempt succeeds.
  - Advantage over a fixed cooldown: short-lived rate limits (which usually clear within seconds) are handled much faster with no wasted wait time; sustained rate limits are still handled patiently at 180s, without hammering the API and making the situation worse.
  - A hard cap of 50 retries per request before giving up and sending a Telegram/Discord failure alert — the script never hangs forever.
- **FAST_MODE=1** for large blocklists or frequent daily changes — cuts run time from tens of minutes down to a few minutes **without increasing rate-limit risk** (verified with a simulated API, identical results to sequential mode): capped at 10 concurrent requests at a time (not firing everything at once), combined with the backoff mechanism above as a second layer of protection if a rate limit is still hit.
- **npm cache** (`cache: "npm"` in `actions/setup-node`) is already enabled in `update-filter-lists.yml` and `defragment-lists.yml` — installs dependencies 2-3x faster, reducing load on the GitHub Actions runner's network bandwidth.

### Other optimizations

- **No Delete & Recreate for the automated daily job** — `update-filter-lists.yml` only runs `cloudflare-create` (incremental sync).
- **⚠️ A dedicated "emergency reset button" exists for when a full wipe is genuinely needed**: the `full-reset.yml` workflow (Actions tab → **Full Reset (Hard Delete & Recreate)** → **Run workflow**, type `RESET` exactly to confirm). It: (1) fully deletes 100% of existing rules + lists, (2) downloads the latest blocklist and rebuilds from scratch, renumbering sequentially as `Chunk 1, 2, 3...`. **Manual trigger only**, no automatic schedule — because this is a destructive action, unsuited for automatic recurring runs. Use it when: switching blocklist sources entirely, or wanting a clean renumbering starting at 1.
- **Safer periodic cleanup**: `defragment-lists.yml` (weekly schedule) consolidates **in place** (never wipes everything, never leaves a "0 protection" gap between phases), achieving the same "clean numbering" goal without Full Reset's risk profile.
- **Monitor your total domain count**: if the total (after deduplication) approaches 300,000 (the Free/Pro limit), consider trimming your blocklist sources or upgrading your Cloudflare plan.
- **Keep workflows separated by responsibility** (already done): `update-filter-lists.yml` (sync), `defragment-lists.yml` (cleanup), `keepalive-update.yml` (infrastructure maintenance) — much easier to debug than a single monolithic workflow.

## 15. Essential security measures

- **Least-privilege API Token**: `Zero Trust: Edit` only, scoped to a single account (covered in section 1).
- **IP allowlisting for GitHub-hosted runners**: **not practical** — GitHub runner IP ranges are shared across millions of other users and change constantly; Cloudflare API Token IP-filtering isn't well suited to that scale. A genuinely effective alternative if you need to lock this down further: use a **self-hosted runner** (your own server) with a static IP, then apply IP allowlisting to the token.
- **No sensitive data in logs**: every secret is only ever passed via `${{ secrets.* }}` → environment variables; GitHub Actions automatically masks secret values in logs. Telegram/Discord notifications only ever contain **counts** (domains, lists, IPs), never specific domain/IP values.
- **Secret Scanning + Push Protection**: covered in section 10 — blocks a secret from ever landing on GitHub, even before the commit succeeds.
- **Verified Commits (GPG)**: covered in section 7 — clearly distinguishes human commits from bot commits.
- **Branch Protection**: covered in section 9 — locks down `main`, only allows a properly-configured bot to push.
- **No permanently expiring tokens**: GitHub App (section 6) — the token lives for 1 hour and regenerates itself, no manual renewal needed.
- **Dependabot**: keeps every Action/library on its latest version, reducing the risk of long-lingering known vulnerabilities (CVEs).

---

## 16. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| HTTP 400 while creating lists, run aborts | Exceeded the 300-lists-per-account limit (300,000 domains / 1,000 per list) | Run `defragment-lists.yml` manually, or trim `BLOCKLIST_URLS` sources |
| **Constant 401 errors, nothing gets deleted/created at all** | **Token is wrong/empty/revoked - NOT a permissions issue** | See the detailed debug section right below |
| HTTP 403 while deleting/creating lists | Token is valid but missing the `Zero Trust > Edit` permission | Fix the token on the Cloudflare Dashboard, add the correct permission |
| No Telegram notifications | `TELEGRAM_TOKEN`/`TELEGRAM_TO` not configured correctly, or the bot was never `/start`ed | Send `/start` to the bot first, double-check the Chat ID |
| `git-auto-commit-action` can't push | "Read and write permissions" not enabled (section 8), or Branch Protection is blocking the bot | Re-check sections 8 and 9 |
| `.node-version` commits lack the Verified badge despite GPG being configured | The GPG public key wasn't added to the GitHub account | Redo section 7, item 4 |
| Want to fully disable the IP blocklist feature | | Delete the `IP_BLOCKLIST_URLS` variable, then manually run `CGPS_DELETION_ENABLED=true npm run cloudflare-delete:ip-list` |
| Edited `BLOCKLIST_URLS` but nothing changed | The workflow hasn't been re-run yet | Go to Actions → **Update Filter Lists** → **Run workflow** to apply it immediately, or wait for the next scheduled run |
| **Reports "success" but the domain/IP count is suspiciously lower than the real source size** | A URL in `BLOCKLIST_URLS`/`IP_BLOCKLIST_URLS` was blocked/rate-limited (403/404) while downloading | Fixed: the log now clearly lists which URLs succeeded (✅) / failed (❌) and why. The job **no longer aborts entirely** just because one URL failed - lists still get created/updated normally using whatever sources did succeed, with a clear warning about what's missing. Check the "Download blocklists"/"Download IP blocklist" step log to see exactly which URL |
| **"Download blocklists"/"Download allowlists" step fails with `response.body.on is not a function`, no lists get created at all** | A real bug, fixed in v11: `response.body` from Node.js's real `fetch()` is a Web ReadableStream, which has no `.on()`. If you still see this, you're on a version older than v11 | Update to the latest version - fixed and verified using a genuine Web ReadableStream (not a mock) |
| **Hundreds of thousands of lines downloaded, but Cloudflare only shows 1 small list (e.g. 300 entries), log shows "Maximum number of blocked domains reached" right after reading the file** | **The `CLOUDFLARE_LIST_ITEM_LIMIT` secret is mistakenly set to a tiny number** (e.g. `300` instead of blank or `300000`) - not a code bug | Check Settings → Secrets and variables → Actions → Secrets → `CLOUDFLARE_LIST_ITEM_LIMIT`. Delete it (falls back to the 300000 default) or fix the value. As of the latest version, the script **prints a loud warning** the moment it detects this value is suspiciously small, so you no longer have to guess |
| **"Incrementally sync rules and lists" job crashes with `Error: undefined`, retries 50 times for a long while then dies with a confusing stack trace** | A real bug, now fixed: the API error handler always showed `undefined` instead of the real reason (usually *"you've reached the 300-lists-per-account limit"*), and permanent 400 errors were being retried like transient ones | Fixed 3 things: (1) the real Cloudflare error reason is now shown, (2) the script stops immediately on a Cloudflare 400 instead of wasting 50 retries, (3) no more crashing via unhandled exception - it now fails cleanly with a clear message and controlled exit (still reports red if domains genuinely couldn't sync - it does not pretend success) |
| **Want to adjust the max domain/IP cap for your Cloudflare plan (Free/Pro/Enterprise)** | Already supported, no new variable needed | Use the existing `CLOUDFLARE_LIST_ITEM_LIMIT` secret (defaults to 300000 for Free/Pro) - set a different value if you're on an Enterprise plan with a higher quota |

### 🔴 Detailed debug: 401 Unauthorized errors (can't delete/create any lists)

**Read the exact error code before guessing the cause** - this is the single most important thing to check:

| Status code | Meaning | Cause |
|---|---|---|
| **401 Unauthorized** | Cloudflare **doesn't recognize this token at all** | Wrong/empty token, a typo when the secret was created, or the token was **deleted/revoked** on the Cloudflare Dashboard |
| **403 Forbidden** | Cloudflare recognizes the token, but it **lacks permission** for the action | Token is missing the `Zero Trust > Edit` permission, or only has `Read` |

If your logs show `Status: 401` (not 403) → the token is **not being accepted at all**, which has nothing to do with "read-only, can't delete". Starting with v5.1, the code **automatically detects and immediately stops** on 401/403 (no longer wasting all 50 retries pointlessly like before, and no longer contributing to secondary 429 errors from hammering the API with a bad token).

**❌ Do NOT switch to the Global API Key.** Here's why:
1. The Global API Key has permission over **your entire Cloudflare account** (DNS, Firewall, every domain...), which seriously violates the least-privilege principle this whole guide is built around.
2. The Global API Key uses a **completely different authentication scheme** (`X-Auth-Email` + `X-Auth-Key`) compared to an API Token (`Authorization: Bearer`) - switching isn't as simple as "granting more permission"; it requires configuring `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_EMAIL` instead of `CLOUDFLARE_API_TOKEN` (the code supports both mechanisms, but this is not the recommended path).
3. A 401 error is almost certainly **unrelated to permission scope at all** - switching to the Global Key won't fix anything if the real cause is an empty or wrong secret.

**✅ Steps to check, in the right order:**

1. Go to the Cloudflare Dashboard → **My Profile** → **API Tokens** → check whether the `CGPS-ZeroTrust-Bot` token (or whatever you named it) **still exists in the list**. If it's gone → the token was deleted, recreate it (see [section 1](#1-get-a-cloudflare-api-token-least-privilege)).
2. If the token still exists, click it → **Roll** (Cloudflare never lets you view an existing token's value again, only replace it with a new one) → copy the new token.
3. Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **Secrets** → find `CLOUDFLARE_API_TOKEN` → **Update** → paste the new token → **Update secret**.
   > Note: GitHub **never lets you view an existing Secret's value** - if you suspect the secret was mistyped or truncated when created, the safest fix is to **delete the old secret and create a brand-new one** rather than "Update" (and make sure there's no stray leading/trailing whitespace - a very common copy-paste mistake).
4. Re-run the workflow: Actions → **Update Filter Lists** → **Run workflow**. If it still fails with 401, check step 5.
5. If it's still 401: the token may have been created but **"Create Token" was never actually clicked** (stopping at the preview/summary screen), meaning the token never really existed. Redo [section 1](#1-get-a-cloudflare-api-token-least-privilege) from scratch.

---

## 17. Enterprise 24/7 hardening

Already applied in this repo (nothing further to do):

- **`timeout-minutes` on every job**: a job stuck for too long (network lag, unresponsive API) is automatically killed instead of occupying a runner for up to 6 hours (GitHub's default) and blocking subsequent runs.
- **`concurrency` on every workflow with overlap risk**: `update-filter-lists.yml`/`defragment-lists.yml`/`full-reset.yml` share one group (never run simultaneously), `keepalive-update.yml` and `dependabot-auto-merge.yml` each have their own group too.
- **Per-job least-privilege permissions** (not set at workflow level): e.g. the `notify-merged` job in `dependabot-auto-merge.yml` only has read access, and `notify-on-failure` in `keepalive-update.yml` has zero repo permissions (`permissions: {}`).
- **Script injection hardening**: any data from `github.event.*` (PR titles, etc. - which can be influenced by outside contributors) is always passed through `env:` before being used in `run:`, never interpolated directly into shell scripts.
- **Real Dependabot merge notifications** (`dependabot-auto-merge.yml`): triggers exactly when a PR is **actually merged** (`pull_request: closed` + `merged == true`), not when auto-merge is merely enabled.

Additional recommendations (up to you, depending on how strict you want to be):

1. **Pin Actions to a commit SHA instead of a floating tag** (`actions/checkout@v6` → `actions/checkout@<full-sha>`). A tag like `@v6` can be repointed to a different commit if the Action's maintainer account is compromised; a SHA cannot. Dependabot still updates pinned SHAs normally (keeping the version-number comment alongside it). Trade-off: harder to read at a glance — reserve this for Actions that handle secrets or sensitive operations (checkout, token-generating actions).
2. **GitHub Environments + Required reviewers for `full-reset.yml`**: Settings → Environments → create a `production-reset` environment → enable "Required reviewers" (yourself or someone else) → add `environment: production-reset` to the `full-reset` job. Result: even if someone has permission to run the workflow and types "RESET" correctly, a second person still has to click "Approve" before the actual deletion runs — an extra human checkpoint for a destructive action.
3. **PING_URL as a dead man's switch**: if Discord and Telegram both fail at the same time (expired bot token, network outage...), you'd have no way of knowing whether the workflow even ran, if you only relied on those two channels. Point `PING_URL` at a service like [healthchecks.io](https://healthchecks.io) (free tier available) and enable "no ping received in X hours" alerting — an independent monitoring layer that doesn't depend on CGPS's own notification system.
4. **Rotate `CLOUDFLARE_API_TOKEN` periodically**: set a reminder (e.g. every 90 days) to generate a new token and revoke the old one on the Cloudflare Dashboard, limiting the window during which a leaked token could cause harm.
5. **Review the Cloudflare Audit Log periodically**: Cloudflare Zero Trust has its own audit log (Dashboard → Manage Account → Audit Log) recording every change to Lists/Rules, including manual changes made outside of CGPS. Check it monthly to catch unexpected changes.
6. **Enable 2FA/MFA on both your Cloudflare and GitHub accounts** — outside the scope of code, but a prerequisite for every measure above to actually mean anything.
7. **Limit the number of Admin-level collaborators on the GitHub repo**: Settings → Collaborators — fewer people with Write/Admin access means a smaller attack surface and less risk of accidental mistakes.

---

## 18. Create a new GitHub repo

Since you want to fully cut ties with any original repo, **do not** use the Fork button. Instead:

1. Go to https://github.com/new → name your repo (e.g. `cloudflare-gateway-pihole-scripts`) → choose **Private** or **Public** → **do NOT** check "Add a README" → **Create repository**.
2. Extract the attached zip, open a terminal in that folder:
   ```bash
   cd cloudflare-gateway-scripts-main
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<username>/<repo-name>.git
   git push -u origin main
   ```
3. Verify on GitHub: your repo does **not** show a "forked from" label — because it was created with `git init`, not a Fork.

> If you haven't created the repo yet, do this section **first**, then come back to section 1 - the ordering here simply groups the secrets/variables setup steps together for a smoother read.
