> 這是維護者自己的部署紀錄（records.3mi.ai），不是自架指南。自架請看 docs/SELF-HOST.md。

# 上線設定：records.3mi.ai

> 這份是維護者自己的部署紀錄（他的網域、Access team、Mac）。想自己架一套的話請看 [`SELF-HOST.md`](SELF-HOST.md)。

目前狀態（2026-09-30 已部署）：

| 項目 | 值 |
|---|---|
| 網址 | https://records.3mi.ai（Worker `tally`，custom domain） |
| D1 | `noteapp`，id `9642be67-5d23-4ba4-a8f7-6b3e2a5829b0` |
| R2 | `noteapp-audio` |
| Cloudflare 帳號 | `<account id>` |

網頁本身已經打得開，但 `/api/*`、`/media/*` 目前一律回 **503 `Access not configured`**。這是故意的 fail-closed：還沒設定 Cloudflare Access 之前，任何人都拿不到資料。照下面步驟做完就會通。

整體架構：手機／瀏覽器用 Google（或 email 驗證碼）登入 Access → 看資料、上傳錄音。兩台 Mac 上的 runner 用各自的 **service token** 通過 Access → 領工作、轉錄、回傳結果。兩台 Mac 可以同時跑，工作用 lease 分配，不會重複處理。

---

## 1. 啟用 Zero Trust、決定 team name

1. 打開 https://one.dash.cloudflare.com ，選你的 Cloudflare 帳號。
2. 第一次進來會要你選 **team name**（例如 `myteam`），並選方案：選 **Free**（50 人以內免費，可能要綁信用卡但不收費）。
3. 已經啟用過的話，到 **Settings → Team name and domain**（舊版介面：Settings → Custom Pages → Team domain）看 team name。
   - 你的 team domain 會是 `<team>.cloudflareaccess.com`，**`<team>` 那段**就是之後的 `ACCESS_TEAM`。

## 2. 加登入方式

**最簡單：One-time PIN（寄驗證碼到 email）**，通常預設就已開啟：

1. **Settings → Authentication → Login methods**（新版可能在 **Integrations → Identity providers**）。
2. 確認列表裡有 **One-time PIN**；沒有就按 **Add new → One-time PIN → Save**。

**想用 Google 帳號一鍵登入（選配）：**

1. 同一頁按 **Add new → Google**，畫面右側會列出要在 Google 端做的事，照做：
   - 到 https://console.cloud.google.com → 建一個專案 → **APIs & Services → OAuth consent screen**，User type 選 External，填 App name、你的 email，存檔。
   - **Credentials → Create credentials → OAuth client ID**，類型 **Web application**：
     - Authorized JavaScript origins：`https://<team>.cloudflareaccess.com`
     - Authorized redirect URIs：`https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`
   - 建好後複製 **Client ID** 和 **Client secret**。
2. 回 Cloudflare 貼上 Client ID / Client secret → **Save** → 按 **Test** 確認能登入。

## 3. 建立 Access 應用程式（self-hosted）

1. **Access → Applications**（新版：**Access controls → Applications**）→ **Add an application** → **Self-hosted**。
2. **Application name**：`tally`
3. **Session Duration**：選 **1 month**（手機才不會一直要重登）。
4. **Public hostname / Application domain**：Subdomain `records`、Domain `3mi.ai`、Path 留空（整個網域都保護）。
5. **Login methods / Identity providers**：勾你在第 2 步開的（One-time PIN 和／或 Google）。建議打開 **Instant Auth**（只有一種登入方式時直接跳過選擇頁）。
6. **Policies** — 加兩條（新版介面可以在這裡 **Create new policy**，或先到 **Access → Policies** 建好再選）：
   - **Policy 1：本人**
     - Policy name：`sammy`
     - Action：**Allow**
     - Include → Selector **Emails** → 值 `you@example.com`（你自己的 email）
   - **Policy 2：runner**
     - Policy name：`runners`
     - Action：**Service Auth**（注意不是 Allow）
     - Include → Selector **Service Token** → 值選第 4 步建的兩個 token（可以先建完 token 再回來編輯這條；或選 **Any Access Service Token**）
7. **Cookie settings**：**SameSite Attribute** 設 **Lax**（擋跨站請求帶登入 cookie）；CORS 等其他設定用預設即可 → **Save / Add application**。

## 4. 建兩個 service token（每台 Mac 一個）

1. **Access → Service auth → Service Tokens**（新版：**Access controls → Service credentials → Service Tokens**）→ **Create Service Token**。
2. Name：`runner-office-mac`，Duration：**Non-expiring** → **Generate token**。
3. 畫面會顯示 **Client ID** 和 **Client Secret**。**Secret 只顯示這一次**，立刻存進密碼管理器。
4. 再做一次，Name：`runner-home-mac`。
5. 回到第 3 步的 app → **Policies** → 編輯 `runners`，Include 選這兩個 token → Save。

## 5. 把 AUD tag 和 team name 設進 Worker

1. **Access → Applications** → 點 `tally`（改名前建立的叫 `noteapp`）→ **Configure / Edit** → **Overview**（或 Basic information）頁面找 **Application Audience (AUD) Tag**，按複製（一串 64 個 hex 字元）。
2. 打開 `web/wrangler.jsonc`，把這行：

   ```jsonc
   "vars": { "ACCESS_TEAM": "", "ACCESS_AUD": "" },
   ```

   改成（換成你的值；`ACCESS_TEAM` 只填 team name，不含 `.cloudflareaccess.com`）：

   ```jsonc
   "vars": { "ACCESS_TEAM": "<team>", "ACCESS_AUD": "貼上AUD" },
   ```

3. 重新部署：

   ```sh
   cd web && npx wrangler deploy
   ```

   > AUD 和 team name 不是機密（它們只用來驗證 JWT），放在 `vars` 就好。
   > 如果你偏好用 secret：先把這兩個 key 從 `vars` 整個刪掉（同名的 var 和 secret 會衝突），再 `npx wrangler secret put ACCESS_TEAM`、`npx wrangler secret put ACCESS_AUD`，最後 `npx wrangler deploy`。
   > **不要**在正式環境設 `DEV_NO_AUTH`（那只給本機 `.dev.vars` 用）。

4. 驗證：
   - 瀏覽器開 https://records.3mi.ai → 會先跳 Access 登入頁 → 登入後看到空的列表（不再是 503）。
   - 用 service token 測 API（在任一台 Mac）：

     ```sh
     curl -s https://records.3mi.ai/api/folders \
       -H "CF-Access-Client-Id: <client id>" \
       -H "CF-Access-Client-Secret: <client secret>"
     ```

     應該回 `[]`。回登入頁 HTML（或 Access 的 403 頁）→ token 沒加進 `runners` policy；回 JSON `{"detail":"forbidden"}` → Worker 驗 JWT 失敗，AUD 或 team name 填錯。

## 6. 每台 Mac 的 `runner/.env`

在 `runner/.env` 加（或補齊）下面這些 key，其餘 STT／ACP 設定參考 `runner/.env.example`：

```sh
API_BASE=https://records.3mi.ai
CF_ACCESS_CLIENT_ID=<這台 Mac 的 token Client ID>
CF_ACCESS_CLIENT_SECRET=<這台 Mac 的 token Client Secret>
RUNNER_NAME=office-mac      # 家裡那台填 home-mac；不填就用 hostname
```

- 公司這台用 `runner-office-mac` 的 token，家裡那台用 `runner-home-mac` 的。
- `.env` 不要 commit、不要互相複製 secret（分開 token 才能單獨撤銷）。

## 7. 家裡的 Mac 從零開始

（Apple Silicon，已裝 Homebrew）

```sh
# 1) 工具
brew install go ffmpeg whisper-cpp node
npm i -g @agentclientprotocol/claude-agent-acp
claude login            # 若沒有 claude 指令：npm i -g @anthropic-ai/claude-code 後再登入

# 2) 取得程式碼
git clone https://github.com/SammyLin/yanroku.git ~/noteapp

# 3) 編譯 runner（sherpa 的 dylib 要跟著 binary 放在 lib/）
cd ~/noteapp/runner
mkdir -p lib && cp "$(go list -m -f '{{.Dir}}' github.com/k2-fsa/sherpa-onnx-go-macos)"/lib/aarch64-apple-darwin/lib{sherpa-onnx-c-api,onnxruntime}.dylib lib/ && chmod u+w lib/*
go build -ldflags '-extldflags "-Wl,-rpath,@executable_path/lib"' -o tally .

# 4) 設定 .env（照第 6 步，用 runner-home-mac 的 token）
cp .env.example .env && open -e .env

# 5) 下載模型（約 1.5 GB，放在 data/models）
./tally models

# 6) 先前景跑一次確認能連線（Ctrl-C 結束）
./tally run
```

### 用 launchd 常駐（開機自動跑、掛了自動重啟）

在 `runner/` 目錄（編譯好 `./tally`、放好 `.env` 之後）執行：

```sh
sh install-launchd.sh
```

它會依這個目錄與目前使用者產生 `~/Library/LaunchAgents/ai.3mi.tally-runner.plist`（不用手改路徑）、移除改名前的 `ai.3mi.noteapp-runner`，並啟動 runner。更新程式後重新編譯，再跑一次即可。

常用指令：

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.3mi.tally-runner.plist   # 啟用並啟動
launchctl kickstart -k gui/$(id -u)/ai.3mi.tally-runner                            # 重啟（改完 .env 或重新編譯後）
launchctl bootout gui/$(id -u)/ai.3mi.tally-runner                                 # 停用
tail -f ~/noteapp/runner/data/logs/runner.log                                             # 看 log
```

注意：
- 用 LaunchAgent（登入使用者身分）而不是 LaunchDaemon，`claude login` 的憑證才讀得到。家裡那台要設成**自動登入**或至少保持登入狀態，並在「系統設定 → 能源」關掉自動睡眠，不然 runner 會停。
- 每台 Mac 都跑一次 `install-launchd.sh` 即可，兩台同時跑沒問題。
- 專案和 `DATA_DIR` 最好放在內建磁碟（APFS）。放在 exFAT 外接碟或網路磁碟時，macOS 會到處產生 `._` 開頭的檔案；runner 已會略過它們，但 git 會出現 `non-monotonic index ._pack-….idx` 這類錯誤，可用 `find .git -name "._*" -delete` 清掉。

## 8. 手機

1. iPhone 用 **Safari**（Android 用 Chrome）開 https://records.3mi.ai ，完成 Access 登入。
2. iPhone：分享按鈕 → **加入主畫面**；Android：右上選單 → **加到主畫面**。
3. 之後從主畫面圖示打開即可錄音（第一次會問麥克風權限，選允許）、上傳、看逐字稿和摘要。
4. 登入狀態維持第 3 步設的 Session Duration（1 個月），過期再登入一次就好。

---

### 疑難排解

| 症狀 | 原因 |
|---|---|
| API 回 503 `Access not configured` | 第 5 步的 `ACCESS_TEAM` / `ACCESS_AUD` 還沒設或沒重新 deploy |
| API 回 403 `{"detail":"forbidden"}` | Worker 驗 JWT 失敗：AUD 複製錯、team name 多打了 `.cloudflareaccess.com` |
| runner 拿到 HTML 登入頁 | `.env` 的 token 錯，或 token 沒加到 `runners`（Service Auth）policy |
| runner log 出現 `whisper-cli: not found` 等 | launchd 的 PATH 沒有 `/opt/homebrew/bin` |
