# Hướng dẫn cài đặt CGPS (Cloudflare Gateway Pi-hole Scripts) — Bản đầy đủ

*(English version: see [INSTALLATION_GUIDE.md](./INSTALLATION_GUIDE.md))*

Tài liệu này hướng dẫn cài đặt **từ đầu đến cuối**, cho repo mới hoàn toàn, độc lập, không phụ thuộc vào bất kỳ repo nào khác. Làm theo đúng thứ tự các bước. (Bước tạo repo GitHub được để ở **mục cuối cùng** - xem [mục 18](#18-tạo-repo-github-mới)).

---

## Mục lục

1. [Lấy Cloudflare API Token (Đặc quyền tối thiểu)](#1-lấy-cloudflare-api-token-đặc-quyền-tối-thiểu)
2. [Cấu hình Secrets bắt buộc](#2-cấu-hình-secrets-bắt-buộc)
3. [Cấu hình danh sách chặn/allow (Variable) - Giải thích chi tiết cách hoạt động](#3-cấu-hình-danh-sách-chặnallow-variable---giải-thích-chi-tiết-cách-hoạt-động)
4. [Bật tính năng chặn theo IP/CIDR (tuỳ chọn)](#4-bật-tính-năng-chặn-theo-ipcidr-tuỳ-chọn)
5. [Cấu hình Telegram thông báo (tuỳ chọn)](#5-cấu-hình-telegram-thông-báo-tuỳ-chọn)
6. [Tạo GitHub App để "bất tử hoá" token (khuyến nghị)](#6-tạo-github-app-để-bất-tử-hoá-token-khuyến-nghị)
7. [Cấu hình GPG ký commit (tuỳ chọn)](#7-cấu-hình-gpg-ký-commit-tuỳ-chọn)
8. [Bật Workflow permissions](#8-bật-workflow-permissions)
9. [Bảo vệ nhánh main (Branch Protection)](#9-bảo-vệ-nhánh-main-branch-protection)
10. [Bật Secret Scanning](#10-bật-secret-scanning)
11. [Bật Dependabot Auto-merge và Thông báo merge](#11-bật-dependabot-auto-merge-và-thông-báo-merge)
12. [Chạy thử lần đầu](#12-chạy-thử-lần-đầu)
13. [Bảng tổng hợp toàn bộ Secrets/Variables](#13-bảng-tổng-hợp-toàn-bộ-secretsvariables)
14. [Giải pháp tối ưu để chạy ổn định](#14-giải-pháp-tối-ưu-để-chạy-ổn-định)
15. [Giải pháp bảo mật cần thiết](#15-giải-pháp-bảo-mật-cần-thiết)
16. [Xử lý sự cố thường gặp](#16-xử-lý-sự-cố-thường-gặp)
17. [Nâng cấp bảo mật/ổn định cho môi trường Enterprise 24/7](#17-nâng-cấp-bảo-mậtổn-định-cho-môi-trường-enterprise-247)
18. [Tạo repo GitHub mới](#18-tạo-repo-github-mới)

---

## 1. Lấy Cloudflare API Token (Đặc quyền tối thiểu)

**Tuyệt đối không dùng Global API Key.** Làm theo nguyên tắc Least Privilege:

1. Đăng nhập [Cloudflare Dashboard](https://dash.cloudflare.com/) → góc phải trên → **My Profile** → **API Tokens**.
2. Bấm **Create Token** → chọn **Create Custom Token**.
3. Đặt tên: `CGPS-ZeroTrust-Bot`.
4. Mục **Permissions**: chỉ thêm đúng 1 dòng:
   - `Account` → `Zero Trust` → `Edit`

   Không thêm bất kỳ quyền nào khác (không DNS, không Firewall, không Access).
5. Mục **Account Resources**: chọn đúng account Cloudflare của bạn (không chọn "All accounts").
6. (Tuỳ chọn, nếu plan hỗ trợ) Mục **Client IP Address Filtering**: để trống — dải IP của GitHub-hosted runner thay đổi liên tục và rất lớn, giới hạn theo IP ở đây gần như không khả thi và không tăng thêm bảo mật thực chất (xem mục [15](#15-giải-pháp-bảo-mật-cần-thiết) để biết giải pháp thay thế hiệu quả hơn).
7. Bấm **Continue to summary** → **Create Token**.
8. **Copy token ngay** (chỉ hiển thị 1 lần).
9. Lấy **Account ID**: ở trang chủ Dashboard, cột phải, mục "Account ID" — copy lại.

---

## 2. Cấu hình Secrets bắt buộc

Vào repo trên GitHub → **Settings** → **Secrets and variables** → **Actions** → tab **Secrets** → **New repository secret**:

| Tên | Giá trị |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token vừa tạo ở bước 1 |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID vừa lấy ở bước 1 |

---

## 3. Cấu hình danh sách chặn/allow (Variable) - Giải thích chi tiết cách hoạt động

`ALLOWLIST_URLS`, `BLOCKLIST_URLS`, `IP_BLOCKLIST_URLS` và `FAST_MODE` được cấu hình dưới dạng **Variable** (không phải Secret) — để bạn dễ xem lại và sửa đổi trực tiếp trong Settings mà không cần mở "giá trị bí mật" mỗi lần. Đây là các URL blocklist công khai (link GitHub raw file), không phải thông tin nhạy cảm như token/mật khẩu.

### Cách hoạt động

- Mỗi biến là 1 **danh sách URL, mỗi dòng 1 URL** (không dùng dấu phẩy, không dùng dấu chấm phẩy - xuống dòng là đủ).
- Code đọc bằng `process.env.BLOCKLIST_URLS.split("\n").filter(x => x)` (xem `lib/constants.js`) - tự động bỏ qua dòng trống, không cần định dạng đặc biệt nào khác.
- `download_lists.js` tải toàn bộ URL trong danh sách, gộp lại thành 1 file duy nhất (`blocklist.txt`/`allowlist.txt`/`ip_blocklist.txt`), rồi `cf_list_create.js`/`cf_ip_list_create.js` xử lý tiếp (khử trùng lặp, loại domain không hợp lệ, so khớp allowlist...).
- **Nếu để trống, hệ thống KHÔNG chặn bất kỳ domain nào cả** (không có danh sách mặc định nào được tự động dùng) — đây là thay đổi có chủ đích: đảm bảo tuyệt đối "chỉ thêm đúng những gì bạn tự cấu hình, không bao giờ tự ý thêm domain/IP lạ". Log và thông báo sẽ ghi rõ cảnh báo "CHƯA CẤU HÌNH" nếu bạn để trống, để không bao giờ có chuyện "tự nhiên xuất hiện domain lạ" mà không rõ nguyên nhân.

### Cách tạo Variable

1. Vào **Settings** → **Secrets and variables** → **Actions** → tab **Variables** (không phải tab Secrets) → **New repository variable**.
2. Tạo variable `BLOCKLIST_URLS`, dán danh sách URL theo đúng định dạng (mỗi dòng 1 URL), ví dụ đầy đủ:
   ```
   https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/pro-onlydomains.txt
   https://raw.githubusercontent.com/adv247/IOS/master/ZLBlock
   https://raw.githubusercontent.com/BlockAdsRouter/Ads/main/NoxADB
   https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/popupads-onlydomains.txt
   https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/fake-onlydomains.txt
   https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/gambling-only/hosts
   https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/native.amazon-onlydomains.txt
   ```
   > Lưu ý: HaGeZi Pro++/Pro dạng Wildcard Domains hoạt động tốt với CGPS vì code tự động bóc tách tiền tố `*.`. Nếu 1 nguồn nào đó chặn nhầm domain hợp lệ, thêm domain đó vào `ALLOWLIST_URLS` (hoặc tạo file allowlist riêng của bạn để lưu domain ngoại lệ).
3. Tạo variable `ALLOWLIST_URLS` tương tự (nếu cần danh sách allow riêng ngoài mặc định) - cùng định dạng, mỗi dòng 1 URL.
4. Tạo variable `FAST_MODE`, giá trị `1` (bật song song, nhanh hơn) hoặc `0`/để trống (tuần tự, mặc định).

### 🎯 Combo khuyến nghị: Domain + IP (copy-paste 1 lần)

**Variable `BLOCKLIST_URLS`** (danh sách domain mẫu ở trên, dùng luôn được).

**Variable `IP_BLOCKLIST_URLS`** (chặn theo dải IP độc hại đã biết - xem [mục 4](#4-bật-tính-năng-chặn-theo-ipcidr-tuỳ-chọn)):
```
https://www.spamhaus.org/drop/drop.txt
https://www.spamhaus.org/drop/edrop.txt
```

Với combo này, mỗi lần chạy `update-filter-lists.yml` sẽ đồng bộ **cả 2 family list riêng biệt**: `CGPS List - Chunk N` (domain) và `CGPS IP List - Chunk N` (IP/CIDR), cùng 2 rule tương ứng (DNS rule + Network rule), hoàn toàn độc lập nhau.

---

## 4. Bật tính năng chặn theo IP/CIDR (tuỳ chọn)

Tính năng mới, **hoàn toàn tách biệt** khỏi domain blocklist — dùng Gateway Network Policy (`net.dst.ip`), tạo family list riêng "CGPS IP List".

1. Chuẩn bị 1 hoặc nhiều nguồn IP/CIDR đáng tin cậy, ví dụ:
   - Spamhaus DROP: `https://www.spamhaus.org/drop/drop.txt`
   - Spamhaus EDROP: `https://www.spamhaus.org/drop/edrop.txt`
   - FireHOL Level 1: `https://raw.githubusercontent.com/firehol/blocklist-ipsets/master/firehol_level1.netset`
2. Tạo **Variable** (Settings → Secrets and variables → Actions → tab **Variables**) tên `IP_BLOCKLIST_URLS`, mỗi dòng 1 URL - cùng định dạng như `BLOCKLIST_URLS` ở mục 3:
   ```
   https://www.spamhaus.org/drop/drop.txt
   https://raw.githubusercontent.com/firehol/blocklist-ipsets/master/firehol_level1.netset
   ```
3. Không cần làm gì thêm — `download_lists.js`, `cf_ip_list_create.js`, `cf_gateway_rule_create.js` tự động phát hiện variable này và bật tính năng.
4. Nếu để trống `IP_BLOCKLIST_URLS`: tính năng tắt hẳn, không ảnh hưởng gì tới phần domain blocklist hiện có (đã kiểm thử).
5. **Giới hạn cần biết**: IP list dùng Gateway Network Policy (filter `l4`) — khác với sản phẩm "Cloudflare Network Firewall" (chỉ dành cho Enterprise). Network Policy này có trên các gói Zero Trust thông thường (Free/Pro/Business), giống cơ chế SNI-filtering đã có sẵn trong CGPS.

---

## 5. Cấu hình Telegram thông báo (tuỳ chọn)

1. Mở Telegram, tìm **@BotFather** → gửi `/newbot` → đặt tên → nhận **Token** (dạng `123456:ABC-DEF...`).
2. Lấy **Chat ID**:
   - Chat riêng: tìm **@userinfobot** → `/start` → lấy ID số.
   - Group: thêm bot vào group → gửi 1 tin nhắn bất kỳ → truy cập `https://api.telegram.org/bot<TOKEN>/getUpdates` → tìm `"chat":{"id": ...}`.
3. Vào **Settings** → **Secrets and variables** → **Actions** → tab **Secrets**, tạo:
   - `TELEGRAM_TOKEN` = token bot
   - `TELEGRAM_TO` = chat ID
4. Từ lần chạy sau, mọi workflow sẽ gửi thông báo trạng thái (số domain, số IP, số list, phiên bản Node.js) và cảnh báo lỗi qua Telegram tự động. Riêng Dependabot: bạn sẽ nhận thông báo "🤖 Dependabot đã tự nâng cấp hệ thống thành công!" ngay khi PR thực sự merge xong (xem [mục 11](#11-bật-dependabot-auto-merge-và-thông-báo-merge)).

---

## 6. Tạo GitHub App để "bất tử hoá" token (khuyến nghị)

Giải quyết vấn đề token hết hạn vĩnh viễn — token sinh ra sống 1 giờ, tự sinh lại mỗi lần chạy.

1. GitHub → ảnh đại diện → **Settings** → cuối menu trái → **Developer settings** → **GitHub Apps** → **New GitHub App**.
2. Điền:
   - **GitHub App name**: ví dụ `zerotrust-sync-bot-2026`
   - **Homepage URL**: link repo của bạn
   - **Webhook**: bỏ tích **Active**
3. Mục **Permissions** → **Repository permissions** → **Contents** → **Read and write**.
4. Cuộn xuống → giữ **Only on this account** → **Create GitHub App**.
5. Copy **App ID** (hiển thị ngay dưới tên App).
6. Cuộn xuống **Private keys** → **Generate a private key** → tải file `.pem`.
7. Menu trái → **Install App** → **Install** → chọn **Only select repositories** → chọn đúng repo của bạn → **Install**.
8. Vào **Settings** → **Secrets and variables** → **Actions** → **Secrets**, tạo:
   - `APP_ID` = App ID vừa copy
   - `APP_PRIVATE_KEY` = toàn bộ nội dung file `.pem` (mở bằng Notepad, copy hết)
9. Workflow `keepalive-update.yml` đã được cấu hình sẵn để tự dùng App này nếu 2 secret trên tồn tại.

**Không làm bước này thì sao?** Workflow tự động fallback về `BOT_PAT_TOKEN` (nếu có) rồi tới `GITHUB_TOKEN` mặc định — vẫn hoạt động, chỉ là không có lợi ích "token bất tử".

---

## 7. Cấu hình GPG ký commit (tuỳ chọn)

Để commit tự động (cập nhật `.node-version`) có nhãn **Verified** màu xanh.

1. Trên máy cá nhân, tạo GPG key (nếu chưa có):
   ```bash
   gpg --full-generate-key
   # Chọn RSA, 4096 bit, không hết hạn (hoặc theo ý bạn)
   ```
2. Lấy key ID:
   ```bash
   gpg --list-secret-keys --keyid-format=long
   ```
3. Xuất private key:
   ```bash
   gpg --armor --export-secret-key <KEY_ID>
   ```
4. Vào GitHub cá nhân → **Settings** → **SSH and GPG keys** → **New GPG key** → export **public** key (`gpg --armor --export <KEY_ID>`) và dán vào đây (để GitHub nhận diện chữ ký).
5. Vào repo → **Settings** → **Secrets and variables** → **Actions** → **Secrets**, tạo:
   - `GPG_PRIVATE_KEY` = nội dung private key ở bước 3
   - `GPG_PASSPHRASE` = passphrase bạn đặt khi tạo key
6. Không làm bước này: commit vẫn hoạt động bình thường, chỉ không có nhãn Verified.

---

## 8. Bật Workflow permissions

**Settings** → **Actions** → **General** → cuộn xuống **Workflow permissions** → chọn **Read and write permissions** → **Save**.

Bắt buộc để `stefanzweifel/git-auto-commit-action` có thể push commit `.node-version`.

---

## 9. Bảo vệ nhánh main (Branch Protection)

**Settings** → **Branches** → **Add branch protection rule**:

1. **Branch name pattern**: `main`
2. Tích **Require a pull request before merging** (khuyến nghị, trừ khi bạn muốn bot tự push thẳng — xem ghi chú dưới).
3. Tích **Require status checks to pass before merging** → chọn các job CI liên quan (nếu có).
4. Tích **Require signed commits** (nếu đã làm mục 7 GPG).
5. Mục **Do not allow bypassing the above settings**: **bỏ tích**, hoặc thêm ngoại lệ cho bot/App của bạn ở mục **Allow specified actors to bypass required pull requests** — nếu không, workflow `keepalive-update.yml` sẽ không thể tự push commit `.node-version` thẳng lên `main`.

> Lưu ý thực tế: Nếu bạn bật "Require a pull request" nghiêm ngặt cho mọi thay đổi bao gồm cả bot, workflow tự động cập nhật `.node-version` sẽ thất bại khi push. Cách đơn giản nhất cho repo cá nhân: **không** bật "Require pull request", chỉ bật "Require signed commits" + để GitHub App/PAT của bot có quyền push thẳng.

---

## 10. Bật Secret Scanning

**Settings** → **Code security and analysis**:
- **Secret scanning**: **Enable**
- **Push protection**: **Enable** (chặn luôn commit chứa secret dạng plain-text trước khi push thành công)

Miễn phí cho repo Public. Repo Private cần GitHub Advanced Security (trả phí) hoặc dùng thay thế mã nguồn mở như [gitleaks](https://github.com/gitleaks/gitleaks) chạy trong 1 workflow riêng nếu cần.

---

## 11. Bật Dependabot Auto-merge và Thông báo merge

1. **Settings** → **General** → cuộn xuống **Pull Requests** → tích **Allow auto-merge**.
2. File `.github/dependabot.yml` và `.github/workflows/dependabot-auto-merge.yml` đã có sẵn trong repo — không cần làm gì thêm. Từ tuần sau, Dependabot sẽ tự tạo PR nâng cấp GitHub Actions/npm packages.
3. **Luồng xử lý đầy đủ đã cài sẵn:**
   - PR loại **patch/minor** → tự động bật auto-merge (`gh pr merge --auto --squash`), GitHub tự merge sau khi mọi status check pass.
   - PR loại **major** → gắn nhãn `needs-manual-review`, không tự merge, bạn tự xem xét.
   - **Ngay khi PR thực sự merge xong** (dù tự động hay merge tay) → job `notify-merged` gửi thông báo Discord + Telegram: "🤖 Dependabot đã tự nâng cấp hệ thống thành công!" kèm tên gói, loại cập nhật, link PR. Thông báo này trigger đúng lúc merge hoàn tất (`pull_request: closed` + `merged == true`), không phải lúc chỉ mới "bật" auto-merge.

---

## 12. Chạy thử lần đầu

1. Vào tab **Actions** trên GitHub → chọn workflow **Update Filter Lists** → **Run workflow** → chọn nhánh `main` → **Run workflow**.
2. Theo dõi log. Lần đầu sẽ mất vài phút vì phải tạo toàn bộ list từ đầu.
3. Nếu đã cấu hình Telegram, bạn sẽ nhận được tin nhắn kết quả (số domain, số list, phiên bản Node.js) hoặc cảnh báo lỗi nếu có.
4. Sau khi chạy xong, vào Cloudflare Dashboard → **Zero Trust** → **Gateway** → **Lists** để xác nhận các list `CGPS List - Chunk N` (và `CGPS IP List - Chunk N` nếu bạn bật tính năng IP) đã xuất hiện.
5. Chạy thử workflow **Keepalive & Node Version Update** tương tự để kiểm tra GitHub App/GPG/Telegram hoạt động đúng.

---

## 13. Bảng tổng hợp toàn bộ Secrets/Variables

| Tên | Loại | Bắt buộc? | Ghi chú |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Secret | ✅ | Zero Trust Edit-only |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | ✅ | |
| `CLOUDFLARE_LIST_ITEM_LIMIT` | Secret | ❌ | Mặc định 300000 |
| `ALLOWLIST_URLS` | Variable | ❌ | Mỗi dòng 1 URL, không dùng dấu phẩy - xem [mục 3](#3-cấu-hình-danh-sách-chặnallow-variable---giải-thích-chi-tiết-cách-hoạt-động) |
| `BLOCKLIST_URLS` | Variable | ❌ | Mỗi dòng 1 URL, không dùng dấu phẩy - xem [mục 3](#3-cấu-hình-danh-sách-chặnallow-variable---giải-thích-chi-tiết-cách-hoạt-động) |
| `IP_BLOCKLIST_URLS` | Variable | ❌ | Bật tính năng chặn IP/CIDR - xem [mục 4](#4-bật-tính-năng-chặn-theo-ipcidr-tuỳ-chọn) |
| `BLOCK_PAGE_ENABLED` | **Secret** | ❌ | `1`/`0` |
| `BLOCK_BASED_ON_SNI` | **Secret** | ❌ | `1`/`0` |
| `FAST_MODE` | Variable | ❌ | `1` = song song nhanh hơn, `0` = tuần tự (mặc định) |
| `DISCORD_WEBHOOK_URL` | Secret | ❌ | |
| `TELEGRAM_TOKEN` | Secret | ❌ | Token bot |
| `TELEGRAM_TO` | Secret | ❌ | Chat ID |
| `PING_URL` | Secret | ❌ | Healthcheck (vd healthchecks.io) |
| `APP_ID` | Secret | ❌ (khuyến nghị) | GitHub App ID |
| `APP_PRIVATE_KEY` | Secret | ❌ (khuyến nghị) | Nội dung `.pem` |
| `BOT_PAT_TOKEN` | Secret | ❌ | Fallback nếu không dùng GitHub App |
| `GPG_PRIVATE_KEY` / `GPG_PASSPHRASE` | Secret | ❌ | Nhãn Verified |

> **Vì sao 4 biến trên là Variable còn `BLOCK_PAGE_ENABLED`/`BLOCK_BASED_ON_SNI` vẫn là Secret?** `ALLOWLIST_URLS`/`BLOCKLIST_URLS`/`IP_BLOCKLIST_URLS`/`FAST_MODE` là những giá trị bạn sẽ **thường xuyên xem lại/chỉnh sửa** (thêm bớt nguồn blocklist, bật tắt tốc độ) nên để dạng Variable cho tiện; giá trị Secret khi xem lại trong Settings sẽ bị ẩn (phải nhập lại từ đầu mỗi lần sửa), gây bất tiện cho việc theo dõi/sửa đổi thường xuyên. `BLOCK_PAGE_ENABLED`/`BLOCK_BASED_ON_SNI` là cấu hình ít khi đổi sau khi thiết lập xong nên giữ Secret cho chắc. Cả hai lựa chọn đều **không** ảnh hưởng tới bảo mật thật sự của hệ thống (đây không phải token/mật khẩu) - khác biệt duy nhất là Variable hiển thị được giá trị khi xem lại trong Settings, Secret thì không.

---

## 14. Giải pháp tối ưu để chạy ổn định

### Chống rate-limit từ Cloudflare (chi tiết)

- **Retry thông minh với backoff tăng dần**: mỗi khi Cloudflare trả lỗi 429 (rate limit), script **không** đợi 1 khoảng cố định mà tăng dần: lần 1 đợi **10 giây**, lần 2 đợi **30 giây**, lần 3 đợi **60 giây**, lần 4 đợi **90 giây**, lần 5 đợi **120 giây**, từ lần 6 trở đi giữ ở **180 giây** (định nghĩa tại `lib/constants.js` → `CLOUDFLARE_RATE_LIMIT_BACKOFF_SCHEDULE`). Đã kiểm thử thực tế: 2 lần dính 429 liên tiếp → tổng thời gian chờ đúng 40s (10s+30s) trước khi thử lại thành công.
  - Ưu điểm so với cooldown cố định: rate-limit ngắn hạn (thường tự hết sau vài giây) được xử lý nhanh hơn nhiều, không lãng phí thời gian chờ; rate-limit kéo dài vẫn được xử lý kiên nhẫn ở mức 180s, không dội liên tục vào API khiến tình trạng rate-limit tệ hơn.
  - Tối đa 50 lần thử lại cho mỗi request trước khi báo lỗi hẳn và gửi thông báo Telegram/Discord — không để script "treo" vô hạn.
- **FAST_MODE=1** khi blocklist lớn hoặc có nhiều thay đổi/ngày — giảm thời gian chạy từ hàng chục phút xuống còn vài phút **mà không tăng rủi ro rate-limit** (đã test với giả lập API, kết quả giống hệt chế độ tuần tự): giới hạn tối đa 10 request chạy đồng thời (không phải "bắn" toàn bộ cùng lúc), kết hợp với cơ chế backoff ở trên làm lớp bảo vệ thứ 2 nếu vẫn chạm rate-limit.
- **Cache npm** (`cache: "npm"` trong `actions/setup-node`) đã bật sẵn ở `update-filter-lists.yml` và `defragment-lists.yml` — cài dependencies nhanh hơn 2-3 lần, giảm tải băng thông GitHub Actions runner.

### Các tối ưu khác

- **Không dùng Delete & Recreate cho tác vụ tự động hàng ngày** — workflow `update-filter-lists.yml` chỉ chạy `cloudflare-create` (incremental sync).
- **⚠️ Có "nút Reset khẩn cấp" riêng khi thật sự cần xoá sạch làm lại**: workflow `full-reset.yml` (Actions tab → **Full Reset (Hard Delete & Recreate)** → **Run workflow**, gõ đúng chữ `RESET` để xác nhận). Workflow này: (1) xoá sạch 100% rule + list hiện có, (2) tải blocklist mới nhất, tạo lại từ đầu, đánh số tuần tự `Chunk 1, 2, 3...`. **Chỉ kích hoạt thủ công**, không có lịch tự động — vì đây là hành động phá huỷ dữ liệu, không phù hợp chạy tự động định kỳ. Dùng khi: đổi hẳn nguồn blocklist, hoặc muốn đánh số Chunk lại từ 1 cho gọn.
- **Dọn dẹp định kỳ an toàn hơn**: `defragment-lists.yml` (lịch hàng tuần) gom nhóm **tại chỗ** (không xoá sạch, không có khoảng trống "0 bảo vệ" giữa 2 giai đoạn), đạt cùng mục tiêu "đánh số gọn gàng" mà không có rủi ro như Full Reset.
- **Theo dõi số lượng domain**: nếu tổng domain (sau khi lọc trùng) tiệm cận 300.000 (giới hạn Free/Pro), cân nhắc bớt bớt nguồn blocklist hoặc nâng gói Cloudflare.
- **Giữ workflow tách biệt theo trách nhiệm** (đã làm): `update-filter-lists.yml` (đồng bộ), `defragment-lists.yml` (dọn dẹp), `keepalive-update.yml` (bảo trì hạ tầng) — dễ debug hơn nhiều so với 1 workflow ôm tất cả.

## 15. Giải pháp bảo mật cần thiết

- **Đặc quyền tối thiểu cho API Token**: chỉ `Zero Trust: Edit`, scope đúng 1 account (đã hướng dẫn ở mục 1).
- **IP Allowlisting cho GitHub-hosted runner**: **không thực tế** — dải IP của GitHub runner dùng chung cho hàng triệu người dùng khác, thay đổi liên tục, và Cloudflare API Token IP-filtering không phù hợp với quy mô này. Giải pháp thực sự hiệu quả hơn nếu bạn cần siết chặt: dùng **self-hosted runner** (máy chủ riêng của bạn) với IP tĩnh, rồi mới áp IP allowlist cho Token.
- **Không log dữ liệu nhạy cảm**: mọi secret chỉ được truyền qua `${{ secrets.* }}` → biến môi trường; GitHub Actions tự động mask giá trị secret khi in ra log. Thông báo Telegram/Discord chỉ chứa **số lượng** (domain, list, IP), không bao giờ chứa domain/IP cụ thể.
- **Secret Scanning + Push Protection**: đã hướng dẫn bật ở mục 10 — chặn ngay cả trước khi commit chứa secret lọt lên GitHub.
- **Verified Commits (GPG)**: đã hướng dẫn ở mục 7 — phân biệt rõ commit người vs commit bot.
- **Branch Protection**: đã hướng dẫn ở mục 9 — khoá nhánh `main`, chỉ cho phép bot đã cấu hình đúng quyền push.
- **Token không hết hạn vĩnh viễn**: GitHub App (mục 6) - token sống 1 giờ, tự sinh lại, không cần con người gia hạn thủ công.
- **Dependabot**: giữ mọi Action/thư viện luôn ở phiên bản mới nhất, giảm rủi ro lỗ hổng đã biết (CVE) tồn đọng lâu ngày.

---

## 16. Xử lý sự cố thường gặp

| Triệu chứng | Nguyên nhân khả dĩ | Cách xử lý |
|---|---|---|
| Lỗi 400 khi tạo list, dừng đột ngột | Vượt giới hạn 300 list/tài khoản (300.000 domain / 1000 mỗi list) | Chạy `defragment-lists.yml` thủ công, hoặc giảm bớt nguồn `BLOCKLIST_URLS` |
| **Lỗi 401 liên tục, không xoá/tạo được list gì cả** | **Token sai/rỗng/đã bị thu hồi - KHÔNG phải lỗi thiếu quyền** | Xem mục debug chi tiết ngay bên dưới |
| Lỗi 403 khi xoá/tạo list | Token hợp lệ nhưng thiếu quyền `Zero Trust > Edit` | Sửa lại token trên Cloudflare Dashboard, thêm đúng quyền |
| Không thấy thông báo Telegram | Chưa cấu hình đúng `TELEGRAM_TOKEN`/`TELEGRAM_TO`, hoặc bot chưa được `/start` | Nhắn `/start` cho bot trước, kiểm tra lại Chat ID |
| `git-auto-commit-action` không push được | Chưa bật "Read and write permissions" (mục 8), hoặc Branch Protection chặn bot | Kiểm tra lại mục 8 và 9 |
| Commit `.node-version` không có nhãn Verified dù đã cấu hình GPG | Public key GPG chưa được thêm vào tài khoản GitHub | Làm lại mục 7, ý 4 |
| Muốn dừng hẳn tính năng IP blocklist | | Xoá variable `IP_BLOCKLIST_URLS`, chạy tay `CGPS_DELETION_ENABLED=true npm run cloudflare-delete:ip-list` |
| Sửa `BLOCKLIST_URLS` xong mà không thấy đổi | Chưa chạy lại workflow | Vào Actions → **Update Filter Lists** → **Run workflow** để áp dụng ngay, hoặc đợi lần chạy theo lịch tiếp theo |
| **Báo "thành công" nhưng số domain/IP thấp bất thường so với nguồn thật** | Có URL trong `BLOCKLIST_URLS`/`IP_BLOCKLIST_URLS` bị chặn/rate-limit (403/404) khi tải | Đã sửa: log giờ liệt kê rõ ràng URL nào tải thành công (✅) / thất bại (❌) kèm lý do. Job **không còn bị chặn hoàn toàn** vì 1 URL lỗi - vẫn tạo/cập nhật list bình thường với dữ liệu từ các nguồn tải được, chỉ cảnh báo rõ nguồn nào thiếu. Xem log bước "Download blocklists"/"Download IP blocklist" để biết chính xác URL nào |
| **Bước "Download blocklists"/"Download allowlists" lỗi `response.body.on is not a function`, không tạo được list nào cả** | Bug thật đã sửa (v11): `response.body` từ `fetch()` thật trong Node.js là Web ReadableStream, không có `.on()`. Nếu vẫn thấy lỗi này, bạn đang dùng bản cũ hơn v11 | Cập nhật lên bản mới nhất - đã sửa và kiểm chứng bằng Web ReadableStream chuẩn (không phải mock) |

### 🔴 Debug chi tiết: Lỗi 401 Unauthorized (không xoá/tạo được list)

**Đọc kỹ mã lỗi trước khi đoán nguyên nhân** - đây là điểm quan trọng nhất:

| Mã lỗi | Ý nghĩa | Nguyên nhân |
|---|---|---|
| **401 Unauthorized** | Cloudflare **không nhận diện được token này là gì cả** | Token sai, rỗng, gõ nhầm khi tạo secret, hoặc token đã bị **xoá/thu hồi (revoke)** trên Cloudflare Dashboard |
| **403 Forbidden** | Cloudflare nhận diện được token, nhưng **token không đủ quyền** thực hiện hành động | Token thiếu quyền `Zero Trust > Edit`, hoặc chỉ có quyền `Read` |

Nếu log của bạn hiện `Status: 401` (không phải 403) → token **hoàn toàn không được chấp nhận**, không liên quan gì tới việc "chỉ đọc không xoá được". Từ v5.1 trở đi, code đã **tự phát hiện và dừng ngay lập tức** khi gặp 401/403 (không lãng phí 50 lần thử lại vô ích như trước, và không còn tự gây thêm lỗi 429 do dội liên tục vào API bằng token sai).

**❌ KHÔNG nên đổi sang Global API Key.** Lý do:
1. Global API Key có quyền **trên TOÀN BỘ tài khoản Cloudflare** (DNS, Firewall, tất cả domain...), vi phạm nghiêm trọng nguyên tắc Đặc quyền tối thiểu đã thiết lập xuyên suốt tài liệu này.
2. Global API Key dùng **cơ chế xác thực khác hẳn** (`X-Auth-Email` + `X-Auth-Key`) so với API Token (`Authorization: Bearer`) - đổi sang không đơn giản là "cấp quyền cao hơn", mà cần cấu hình `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_EMAIL` thay vì `CLOUDFLARE_API_TOKEN` (code đã hỗ trợ sẵn 2 cơ chế, nhưng đây không phải hướng giải quyết được khuyến nghị).
3. Lỗi 401 gần như chắc chắn **không liên quan gì tới phạm vi quyền** - đổi sang Global Key sẽ không sửa được nếu nguyên nhân là secret rỗng/sai.

**✅ Các bước kiểm tra đúng thứ tự:**

1. Vào Cloudflare Dashboard → **My Profile** → **API Tokens** → kiểm tra token `CGPS-ZeroTrust-Bot` (hoặc tên bạn đặt) **còn tồn tại trong danh sách không**. Nếu không thấy → token đã bị xoá, cần tạo lại (xem [mục 1](#1-lấy-cloudflare-api-token-đặc-quyền-tối-thiểu)).
2. Nếu token vẫn còn, bấm vào token đó → **Roll** (Cloudflare không cho xem lại token cũ, chỉ có thể tạo token mới thay thế) → copy token mới.
3. Vào repo GitHub → **Settings** → **Secrets and variables** → **Actions** → **Secrets** → tìm `CLOUDFLARE_API_TOKEN` → **Update** → dán token mới vào → **Update secret**.
   > Lưu ý: GitHub **không cho xem lại giá trị Secret cũ** - nếu nghi ngờ secret bị gõ sai/thiếu ký tự lúc tạo, cách chắc chắn nhất là **xoá secret cũ, tạo lại secret mới** thay vì "Update" (đảm bảo không dính khoảng trắng thừa ở đầu/cuối - lỗi rất hay gặp khi copy-paste).
4. Chạy thử lại workflow: Actions → **Update Filter Lists** → **Run workflow**. Nếu vẫn lỗi 401, kiểm tra tiếp bước 5.
5. Nếu vẫn 401: có thể do token được tạo nhưng **quên bấm "Create Token"** ở bước cuối (chỉ dừng ở bước xem trước/summary), dẫn đến token không thực sự tồn tại. Làm lại toàn bộ [mục 1](#1-lấy-cloudflare-api-token-đặc-quyền-tối-thiểu) từ đầu.

---

## 17. Nâng cấp bảo mật/ổn định cho môi trường Enterprise 24/7

Các mục **đã áp dụng sẵn** trong repo (không cần làm gì thêm):

- **`timeout-minutes` trên mọi job**: job treo quá lâu (mạng lag, API không phản hồi) sẽ tự bị huỷ thay vì chiếm runner tới 6 tiếng (giới hạn mặc định của GitHub) và chặn các lần chạy sau.
- **`concurrency` trên mọi workflow có rủi ro chồng chéo**: `update-filter-lists.yml`/`defragment-lists.yml`/`full-reset.yml` dùng chung 1 group (không bao giờ chạy đồng thời), `keepalive-update.yml` và `dependabot-auto-merge.yml` cũng có group riêng.
- **Đặc quyền tối thiểu theo từng job** (không đặt ở cấp workflow): ví dụ job `notify-merged` trong `dependabot-auto-merge.yml` chỉ có quyền đọc, job `notify-on-failure` trong `keepalive-update.yml` không có quyền gì với repo (`permissions: {}`).
- **Chống script injection**: mọi dữ liệu từ `github.event.*` (PR title, v.v. - có thể bị ảnh hưởng bởi người ngoài) đều được truyền qua `env:` trước khi dùng trong `run:`, không bao giờ nội suy trực tiếp vào script shell.
- **Thông báo Dependabot merge thật** (`dependabot-auto-merge.yml`): trigger đúng lúc PR **thực sự merge xong** (`pull_request: closed` + `merged == true`), không phải lúc mới bật auto-merge.

Các mục **khuyến nghị bổ sung** (cần bạn tự làm, tuỳ mức độ nghiêm ngặt mong muốn):

1. **Ghim Action theo commit SHA thay vì tag nổi** (`actions/checkout@v6` → `actions/checkout@<sha-đầy-đủ>`). Một tag như `@v6` có thể bị trỏ lại sang commit khác nếu tài khoản chủ Action bị chiếm đoạt; SHA thì không thể. Dependabot vẫn tự cập nhật SHA bình thường (giữ nguyên comment ghi số version bên cạnh). Đánh đổi: khó đọc hơn, chỉ nên làm cho các Action xử lý bí mật/thao tác nhạy cảm (checkout, các action tạo token).
2. **GitHub Environments + Required reviewers cho `full-reset.yml`**: Settings → Environments → tạo environment `production-reset` → bật "Required reviewers" (chọn chính bạn hoặc 1 người khác) → sửa job `full-reset` thêm `environment: production-reset`. Kết quả: dù ai đó có quyền chạy workflow và gõ đúng "RESET", vẫn cần thêm 1 người bấm "Approve" trước khi lệnh xoá thật sự chạy — thêm 1 lớp con người xác nhận cho hành động phá huỷ dữ liệu.
3. **PING_URL như "chuông báo tử" (dead man's switch)**: nếu Discord/Telegram cùng lúc gặp sự cố (bot token hết hạn, mất mạng...), bạn sẽ KHÔNG biết workflow có chạy hay không nếu chỉ dựa vào 2 kênh đó. Cấu hình `PING_URL` trỏ tới dịch vụ như [healthchecks.io](https://healthchecks.io) (miễn phí), bật cảnh báo "không nhận được ping trong X giờ" - đây là lớp giám sát độc lập, không phụ thuộc vào chính hệ thống thông báo của CGPS.
4. **Xoay vòng (rotate) `CLOUDFLARE_API_TOKEN` định kỳ**: đặt lịch nhắc (VD: mỗi 90 ngày) tự tạo token mới, xoá token cũ trên Cloudflare Dashboard - hạn chế thời gian 1 token bị lộ có thể gây hại.
5. **Xem lại Cloudflare Audit Log định kỳ**: Cloudflare Zero Trust có log audit riêng (Dashboard → Manage Account → Audit Log) ghi lại MỌI thay đổi tới Lists/Rules, kể cả thay đổi thủ công ngoài CGPS. Nên xem qua hàng tháng để phát hiện thay đổi bất thường không đến từ workflow.
6. **Bật 2FA/MFA cho tài khoản Cloudflare và GitHub** - không nằm trong phạm vi code, nhưng là điều kiện tiên quyết cho mọi biện pháp trên có ý nghĩa.
7. **Giới hạn số người có quyền Admin trên repo GitHub**: Settings → Collaborators - càng ít người có quyền Write/Admin, bề mặt tấn công/lỗi thao tác nhầm càng nhỏ.

---

## 18. Tạo repo GitHub mới

Vì bạn muốn cắt đứt hoàn toàn liên kết với repo gốc, **không** dùng nút Fork. Làm như sau:

1. Vào https://github.com/new → đặt tên repo (ví dụ `cloudflare-gateway-pihole-scripts`) → chọn **Private** hoặc **Public** tuỳ ý → **KHÔNG** tích "Add a README" → bấm **Create repository**.
2. Giải nén file zip đính kèm, mở terminal tại thư mục đó:
   ```bash
   cd cloudflare-gateway-scripts-main
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<username>/<ten-repo>.git
   git push -u origin main
   ```
3. Kiểm tra trên GitHub: repo của bạn **không** có nhãn "forked from" — vì được tạo bằng `git init`, không phải Fork.

> Nếu bạn chưa tạo repo, làm mục này **trước tiên** rồi quay lại mục 1 - thứ tự trình bày ở đây chỉ để nhóm các bước cấu hình secrets/variables lên trước cho liền mạch.
