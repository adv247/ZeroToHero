# Cloudflare Gateway Pi-hole Scripts (CGPS)

![Cloudflare Gateway Analytics screenshot showing a thousand blocked DNS requests](.github/images/gateway_analytics.png)

Cloudflare Gateway allows you to create custom rules to filter HTTP, DNS, and network traffic based on your firewall policies. This is a collection of scripts that can be used to get a similar experience as if you were using Pi-hole, but with Cloudflare Gateway - so no servers to maintain or need to buy a Raspberry Pi!

> 📖 **Hướng dẫn cài đặt đầy đủ, chi tiết từng bước**: [HUONG_DAN_CAI_DAT.md](./HUONG_DAN_CAI_DAT.md) (Tiếng Việt) / [INSTALLATION_GUIDE.md](./INSTALLATION_GUIDE.md) (English) - bao gồm Secrets, GitHub App, GPG, Branch Protection, IP blocklist, Telegram, và các giải pháp bảo mật/tối ưu.

## About the individual scripts

- `cf_list_delete.js` - Deletes all lists created by CGPS from Cloudflare Gateway. This is useful for subsequent runs.
- `cf_list_create.js` - Takes a blocklist.txt file containing domains and creates lists in Cloudflare Gateway
- `cf_ip_list_create.js` - Optional: takes an ip_blocklist.txt file containing IPs/CIDRs and syncs them as a separate "CGPS IP List" family in Cloudflare Gateway. No-op if IP_BLOCKLIST_URLS isn't configured.
- `cf_ip_list_delete.js` - Deletes all IP lists created by cf_ip_list_create.js.
- `cf_gateway_rule_create.js` - Creates a Cloudflare Gateway rule to block all traffic if it matches the lists created by CGPS.
- `cf_gateway_rule_delete.js` - Deletes the Cloudflare Gateway rule created by CGPS. Useful for subsequent runs.
- `cf_defragment.js` - Consolidates lists (both domain and IP families) into the minimum number of lists needed, and deletes now-empty lists left over from removals.
- `download_lists.js` - Initiates blocklist, allowlist, and (optionally) IP blocklist download.

## Features

- Support for basic hosts files
- Full support for domain lists, including Wildcard-format lists (e.g. HaGeZi's Pro++) - the `*.` prefix is stripped automatically
- **Optional IP/CIDR blocklist** support, completely separate from the domain blocklist, enforced via a Gateway Network policy
- Automatically cleans up filter lists: removes duplicates, invalid domains, comments and more
- Works **fully unattended**
- **Allowlist support**, allowing you to prevent false positives and breakage by forcing trusted domains to always be unblocked.
- Experimental **SNI-based filtering** that works independently of DNS settings, preventing unauthorized or malicious DNS changes from bypassing the filter.
- Optional health check: Sends a ping request ensuring continuous monitoring and alerting for the workflow execution, or messages a Discord/Telegram webhook with progress.

## Usage

### Prerequisites

1. Node.js installed on your machine
2. Cloudflare [Zero Trust](https://one.dash.cloudflare.com/) account - the Free plan is enough. Use the Cloudflare [documentation](https://developers.cloudflare.com/cloudflare-one/) for details.
3. Cloudflare email, API **token** with Zero Trust read and edit permissions, and account ID. See [extended_guide.md](./extended_guide.md#cloudflare_api_token) for more information about how to create the token.
4. A file containing the domains you want to block - **max 300,000 domains for the free plan** - in the working directory named `blocklist.txt`. Mullvad provides awesome [DNS blocklists](https://github.com/mullvad/dns-blocklists) that work well with this project. A script that downloads recommended blocklists, `download_lists.js`, is included.
5. Optional: You can whitelist domains by putting them in a file `allowlist.txt`. You can also use the `get_recomended_whitelist.sh` Bash script to get the recommended whitelists.
6. Optional: A Discord (or similar) webhook URL to send notifications to.

### Running locally

1. Clone this repository.
2. Run `npm install` to install dependencies.
3. Copy `.env.example` to `.env` and fill in the values.
4. If you haven't downloaded any filters yourself, run the `node download_lists.js` command to download recommended filter lists (OISD Small and AdAway; about 50 000 domains).
5. Run `node cf_list_create.js` to create the lists in Cloudflare Gateway. This will take a while.
6. Run `node cf_gateway_rule_create.js` to create the firewall rule in Cloudflare Gateway.
7. Profit! Time is money after all. You can update the lists by repeating steps 4, 5 and 6.

### Running via GitHub Actions (fully automated)

Tổng hợp toàn bộ Secrets/Variables được các workflow trong `.github/workflows/` sử dụng:

| Tên | Loại | Bắt buộc? | Dùng bởi | Ghi chú |
|---|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Secret | ✅ | `update-filter-lists.yml`, `defragment-lists.yml` | Token Zero Trust Edit-only, không dùng Global API Key |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | ✅ | `update-filter-lists.yml`, `defragment-lists.yml` | |
| `CLOUDFLARE_LIST_ITEM_LIMIT` | Secret | ❌ | `update-filter-lists.yml` | Mặc định 300000 nếu bỏ trống |
| `ALLOWLIST_URLS` / `BLOCKLIST_URLS` | Variable | ❌ | `update-filter-lists.yml` | Danh sách URL, mỗi dòng 1 URL (không dùng dấu phẩy). Dùng **Variable** để dễ xem/sửa trực tiếp trong Settings - đây là URL blocklist công khai, không phải thông tin nhạy cảm |
| `IP_BLOCKLIST_URLS` | Variable | ❌ | `update-filter-lists.yml` | Tuỳ chọn: chặn theo dải IP/CIDR (mỗi dòng 1 IP/CIDR). Để trống = tắt hẳn tính năng |
| `BLOCK_PAGE_ENABLED` / `BLOCK_BASED_ON_SNI` | **Secret** | ❌ | tương ứng | `1` hoặc `0` |
| `FAST_MODE` | Variable | ❌ | `update-filter-lists.yml`, `defragment-lists.yml` | `1` = chạy song song nhanh hơn nhiều lần, `0`/để trống = tuần tự (mặc định) |
| `DISCORD_WEBHOOK_URL` | Secret | ❌ | mọi script `cf_*.js` | Thông báo qua Discord |
| `TELEGRAM_TOKEN` | Secret | ❌ | mọi workflow | Token bot Telegram (tạo qua @BotFather) |
| `TELEGRAM_TO` | Secret | ❌ | mọi workflow | Chat ID nhận thông báo |
| `PING_URL` | Secret | ❌ | `update-filter-lists.yml` | Healthcheck URL (ví dụ healthchecks.io) |
| `APP_ID` | Secret | ❌ | `keepalive-update.yml` | App ID của GitHub App riêng, dùng để sinh token tự động không hết hạn |
| `APP_PRIVATE_KEY` | Secret | ❌ | `keepalive-update.yml` | Nội dung file `.pem` của GitHub App |
| `BOT_PAT_TOKEN` | Secret | ❌ | `keepalive-update.yml` | Fine-grained PAT, dùng làm phương án dự phòng nếu không cấu hình GitHub App |
| `GPG_PRIVATE_KEY` / `GPG_PASSPHRASE` | Secret | ❌ | `keepalive-update.yml` | Ký GPG để commit tự động có nhãn "Verified" |

Cấu hình tại: repo Settings → **Secrets and variables** → **Actions** → tab **Secrets** hoặc **Variables** tương ứng ở cột "Loại" phía trên.

### Running in GitHub Actions

These scripts can be run using GitHub Actions so your filters will be automatically updated and pushed to Cloudflare Gateway. This is useful if you are using a frequently updated blocklist.

Please note that:
- GitHub Actions wasn't intended to be used for this purpose, therefore the local options are recommended.
- the GitHub Action downloads the recommended blocklists and whitelist by default. You can change this behavior by setting Actions variables.

1. Create a new empty, private repository. Forking or public repositories are discouraged, but supported - although the script never leaks your API keys and GitHub Actions secrets are automatically redacted from the logs, it's better to be safe than sorry. There is **no need to use the "Sync fork" button** if you're doing that! The GitHub Action downloads the latest code regardless of what's in your forked repository.
2. Create the following GitHub Actions secrets in your repository settings:
   - `CLOUDFLARE_API_TOKEN`: Your Cloudflare API Token with Zero Trust read and edit permissions
   - `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare account ID
   - `CLOUDFLARE_LIST_ITEM_LIMIT`: The maximum number of blocked domains allowed for your Cloudflare Zero Trust plan. Default to 300,000. Optional if you are using the free plan.
   - `PING_URL`: /Optional/ The HTTP(S) URL to ping (using curl) after the GitHub Action has successfully updated your filters. Useful for monitoring.
   - `DISCORD_WEBHOOK_URL`: /Optional/ The Discord (or similar) webhook URL to send notifications to. Good for monitoring as well.
3. Create the following GitHub Actions variables in your repository settings if you desire:
   - `ALLOWLIST_URLS`: Uses your own allowlists. One URL per line. Recommended allowlists will be used if this variable is not provided.
   - `BLOCKLIST_URLS`: Uses your own blocklists. One URL per line. Recommended blocklists will be used if this variable is not provided.
   - `BLOCK_PAGE_ENABLED`: Enable showing block page if host is blocked.
4. Create a new file in the repository named `.github/workflows/main.yml` with the contents of `auto_update_github_action.yml` found in this repository. The default settings will update your filters every week at 3 AM UTC. You can change this by editing the `schedule` property.
5. Enable GitHub Actions in your repository settings.

### DNS setup for Cloudflare Gateway

1. Go to your Cloudflare Zero Trust dashboard, and navigate to Gateway -> DNS Locations.
2. Click on the default location or create one if it doesn't exist.
3. Configure your router or device based on the provided DNS addresses.

Alternatively, you can install the Cloudflare WARP client and log in to Zero Trust. This method proxies your traffic over Cloudflare servers, meaning it works similarly to a commercial VPN. You need to do this if you want to use the SNI-based filtering feature, as it requires Cloudflare to inspect your raw traffic (HTTPS remains encrypted if "TLS decryption" is disabled).

### Malware blocking

The default filter lists are only optimized for ad & tracker blocking because Cloudflare Zero Trust itself comes with much more advanced security features. It's recommended that you create your own Cloudflare Gateway firewall policies that leverage those features on top of CGPS.

### Dry runs

To see if e.g. your filter lists are valid without actually changing anything in your Cloudflare account, you can set the `DRY_RUN` environment variable to 1, either in `.env` or the regular way. This will only print info such as the lists that would be created or the amount of duplicate domains to the console.

**Warning:** This currently only works for `cf_list_create.js`.

<!-- markdownlint-disable-next-line MD026 -->
## Why not...

### Pi-hole or Adguard Home?

- Complex setup to get it working outside your home
- Requires a Raspberry Pi

### NextDNS?

- DNS filtering is disabled after 300,000 queries per month on the free plan

### Cloudflare Gateway?

- Requires a valid payment card or PayPal account
- Limit of 300k domains on the free plan

### a hosts file?

- Potential performance issues, especially on [Windows](https://github.com/StevenBlack/hosts/issues/93)
- No filter updates
- Doesn't work for your mobile device
- No statistics on how many domains you've blocked

## License

MIT License. See `LICENSE` for more information.
