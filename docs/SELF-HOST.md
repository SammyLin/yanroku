# 自架 Yanroku（言錄）

> **English summary.** Yanroku (repo `SammyLin/yanroku`) is self-hosted: a Cloudflare Worker (`web/`) stores metadata in D1 and audio in R2, behind Cloudflare Access; one or more Apple Silicon Macs run the Go runner (`runner/`) that claims jobs and does transcription (whisper.cpp or Groq), speaker diarization (sherpa-onnx) and clean-up / summaries / Ask through a local ACP agent — Claude Code by default, or Codex — so these run on the Claude or ChatGPT subscription you already have, with no separate API bill (see 4.5). To self-host: (1) put your own domain on Cloudflare, (2) create your own D1 + R2 and add a wrangler `env` with their names, (3) apply migrations and deploy, (4) protect the domain with Cloudflare Access (your email + a Service Auth policy with one service token per runner) and set `ACCESS_TEAM` / `ACCESS_AUD`, (5) build and install the runner on a Mac with `runner/.env` pointing at your domain, (6) connect the Yanroku iOS app (https://yanroku.app, "連線到自己的伺服器") or a browser. `docs/SETUP.md` is the maintainer's own deployment log; this file is the general guide.

這份是給「clone 這個 repo、要架在自己 Cloudflare 帳號上」的人看的。以下所有 `your-domain.com`、`<team>`、`<db-id>` 都是佔位，換成你自己的值。

---

## 1. 需要準備什麼

| 項目 | 說明 |
|---|---|
| Cloudflare 帳號 | 免費註冊即可開始 |
| 你自己的網域，DNS 放在 Cloudflare | Worker 要掛 custom domain，Cloudflare Access 也要保護這個網域。例如 `notes.your-domain.com` |
| Workers Paid 方案（建議，每月 US$5） | Free 方案每個請求只有 10 ms CPU，而每個 API 請求都要驗 Access JWT，上傳大檔、匯出逐字稿、批次寫 D1 很容易超過；Paid 的 CPU、D1、R2 額度也大很多。`docs/SPEC.md` 就是以 Paid 為前提設計 |
| Apple Silicon Mac（runner 用） | runner 連結 sherpa-onnx 的 **macOS arm64** dylib（`lib/aarch64-apple-darwin`），Intel Mac 和 Linux 目前跑不了。要能長時間開著、不睡眠 |
| Groq API key（選配） | `STT_PROVIDER=groq` 時用 Groq Whisper 轉錄，比本機快，但音訊會離開你的 Mac。不填就用本機 whisper.cpp（Metal） |
| Claude Code 或 Codex（本機 ACP agent） | 逐字稿整理、標題、摘要、Ask 都透過 ACP agent 用你已經有的 Claude 或 ChatGPT 訂閱在 Mac 上跑，不用另外申請 API key、不另外計費。逐字稿文字會送到該 agent 使用的模型。設定見 [4.5](#45-用你自己的-ai-訂閱claude-code-或-codex) |
| iPhone（選配） | 用 Yanroku App；不用 App 的話，瀏覽器開你的網址也能錄音、上傳、看結果 |

---

## 2. 部署 Worker

先 clone，之後的指令都在 `web/` 目錄下執行。

```sh
git clone https://github.com/SammyLin/yanroku.git
cd yanroku/web
npm install
npx wrangler login
```

### 2.1 建 D1 和 R2（名稱自己取）

```sh
npx wrangler d1 create yanroku          # 輸出裡有 database_id，記下來
npx wrangler r2 bucket create yanroku-audio
```

### 2.2 在 `wrangler.jsonc` 加一個你自己的 env

`web/wrangler.jsonc` 最上層是維護者自己的正式環境（他的 D1 id、R2 名稱、網域 `routes`、`ACCESS_TEAM` / `ACCESS_AUD`、VAPID 公鑰），**不要直接用最上層部署**，它的 `routes` 指向別人的網域。

建議做法：在最上層加一個 `"env"` 區塊，放你自己的環境（例如 `mine`）。wrangler 的 env **不繼承** bindings、`vars`、`routes`，所以維護者的值不會跑進來；`main`、`assets`、`compatibility_date` 這些則會沿用。

```jsonc
  "env": {
    "mine": {
      "name": "yanroku",       // 你的 Worker 名稱
      "d1_databases": [
        { "binding": "DB", "database_name": "yanroku", "database_id": "<db-id>", "migrations_dir": "migrations" }
      ],
      "r2_buckets": [{ "binding": "AUDIO", "bucket_name": "yanroku-audio" }],
      "vars": {
        "ACCESS_TEAM": "",     // 第 3 步填
        "ACCESS_AUD": "",      // 第 3 步填
        "VOICE_MATCH_THRESHOLD": "0.65",
        "VOICE_SUGGEST_THRESHOLD": "0.50"
      },
      "routes": [{ "pattern": "notes.your-domain.com", "custom_domain": true }]
    }
  }
```

要改的欄位一覽：

| 欄位 | 填什麼 |
|---|---|
| `name` | 你的 Worker 名稱 |
| `d1_databases[0].database_name` / `database_id` | 2.1 建的 D1 名稱和 id（`binding` 必須是 `DB`） |
| `r2_buckets[0].bucket_name` | 2.1 建的 bucket（`binding` 必須是 `AUDIO`） |
| `routes[0].pattern` | 你的網域（`custom_domain: true`，該網域的 zone 必須在同一個 Cloudflare 帳號） |
| `vars.ACCESS_TEAM` / `ACCESS_AUD` | 第 3 步取得 |
| `VAPID_PUBLIC_KEY` / `VAPID_SUBJECT` + secret `VAPID_PRIVATE_KEY` | 選配，Web Push「處理完成」通知。不設就沒有推播（格式見 `web/src/push.ts` 開頭註解） |
| `TRANSFER_ENABLED` | 選配，設成 `"1"` 才會在「設定 › 搬家」出現匯出／匯入：把帳號整個搬到另一台伺服器（Yanroku Cloud ⇄ 自架）。不設就關閉，相關 API 回 404 |

> 也可以直接改最上層那幾個欄位，但之後 `git pull` 會一直和上游衝突，用 env 比較乾淨。

### 2.3 套用 migrations、部署

```sh
npx wrangler d1 migrations apply yanroku --remote --env mine
npx wrangler deploy --env mine
```

`yanroku` 換成你的 `database_name`。部署後打開 `https://notes.your-domain.com`，網頁會出現，但 `/api/*` 一律回 **503 `Access not configured`**。這是故意的 fail-closed：設好 Access 之前沒人拿得到資料。

> **不要**在正式環境設 `DEV_NO_AUTH`，那只給本機 `.dev.vars` 開發用。

---

## 3. 用 Cloudflare Access 保護

在 https://one.dash.cloudflare.com （Zero Trust）操作。介面名稱會隨改版變動，以下用目前常見的名稱。

1. **啟用 Zero Trust、決定 team name**：第一次進來會要你選 team name 和方案（Free 方案 50 人內免費）。你的 team domain 是 `<team>.cloudflareaccess.com`，**`<team>`** 就是 `ACCESS_TEAM`。
2. **登入方式**：Settings → Authentication → Login methods，確認有 **One-time PIN**（寄驗證碼到 email）。想用 Google 一鍵登入可另外加 Google IdP。
3. **建 service token（每台 runner 一個）**：Access → Service auth → Service Tokens → Create Service Token，Duration 選 Non-expiring。**Client Secret 只顯示一次**，馬上存好。每台 Mac 各一個，之後才能單獨撤銷。
4. **建 Access 應用程式**：Access → Applications → Add an application → **Self-hosted**
   - Application domain：`notes.your-domain.com`，Path 留空（整個網域）
   - Session Duration：建議 1 month（手機不用一直重登）
   - Policies 兩條：
     - **你本人**：Action **Allow**，Include → Emails → `you@your-domain.com`
     - **runner**：Action **Service Auth**（不是 Allow），Include → Service Token → 選第 3 步的 token
   - Cookie settings：SameSite 設 **Lax**
5. **取 AUD**：打開剛建的 application → Overview / Basic information → **Application Audience (AUD) Tag**（64 個 hex 字元）。
6. 把值填進你的 env：

   ```jsonc
   "ACCESS_TEAM": "<team>",      // 只填 team name，不含 .cloudflareaccess.com
   "ACCESS_AUD": "<aud tag>",
   ```

   AUD 和 team name 不是機密（只用來驗 JWT），放 `vars` 就好。然後重新部署：`npx wrangler deploy --env mine`。

7. **驗證**
   - 瀏覽器開 `https://notes.your-domain.com` → 先跳 Access 登入 → 登入後看到空的列表。
   - 用 service token 測 API：

     ```sh
     curl -s https://notes.your-domain.com/api/folders \
       -H "CF-Access-Client-Id: <client id>" \
       -H "CF-Access-Client-Secret: <client secret>"
     ```

     應該回 JSON。回登入頁 HTML → token 沒加進 Service Auth policy；回 `{"detail":"forbidden"}` → AUD 或 team name 填錯。

---

## 4. 設定 runner（每台 Mac）

需要 Apple Silicon、已裝 Homebrew。

### 4.1 工具

```sh
brew install go ffmpeg whisper-cpp node
npm i -g @agentclientprotocol/claude-agent-acp
claude login        # 沒有 claude 指令的話：npm i -g @anthropic-ai/claude-code 再登入
```

想用 Codex（ChatGPT 訂閱）代替 Claude Code，見 [4.5](#45-用你自己的-ai-訂閱claude-code-或-codex)。

Go 版本要符合 `runner/go.mod`（目前 1.26）。

### 4.2 取得程式碼、設定 `.env`

```sh
git clone https://github.com/SammyLin/yanroku.git ~/yanroku
cd ~/yanroku/runner
cp .env.example .env
```

`.env` 至少要改：

```sh
API_BASE=https://notes.your-domain.com     # 必填，沒有預設值；沒設 runner 會直接報錯停止
CF_ACCESS_CLIENT_ID=<這台 Mac 的 token Client ID>
CF_ACCESS_CLIENT_SECRET=<這台 Mac 的 token Client Secret>
# RUNNER_NAME=office-mac                   # 選填，預設是 hostname
```

`API_BASE` 是必填，沒有預設值。請設成你自己的 Worker 網址（例如 `https://notes.example.com`）。沒設、空白或網址格式不對，`yanroku run` 會直接報錯結束。

其他 key（都在 `runner/.env.example`）：

| key | 說明 |
|---|---|
| `STT_PROVIDER` | `local`（whisper-cli，預設）或 `groq` |
| `GROQ_API_KEY` / `GROQ_MODEL` | `groq` 時必填 key；model 預設 `whisper-large-v3` |
| `WHISPER_MODEL` / `WHISPER_LANG` | 預設 `data/models/ggml-large-v3-turbo.bin`、`zh` |
| `DIARIZE` / `NUM_SPEAKERS` | `DIARIZE=0` 關掉分講者；`NUM_SPEAKERS=0` 自動判斷人數 |
| `ACP_AGENT` / `ACP_MODEL` | 預設 `claude-agent-acp`、`opus`。換成 Codex 見 4.5；`ACP_MODEL` 只對 Claude Code 有效 |
| `DATA_DIR` | 模型、暫存、log 的位置，預設 `data` |
| `RUNNER_TOKEN` | 自架留空（Cloudflare Access 用上面的 service token） |

`.env` 不要 commit，也不要在兩台 Mac 之間共用 token。

### 4.3 編譯、下載模型

最簡單：

```sh
~/yanroku/runner/deploy.sh
```

它會 `git pull --ff-only`、編譯 `yanroku`、把 sherpa 的 dylib 放到 `lib/`、執行 `./yanroku models` 下載模型（約 1.5 GB，放在 `data/models`）、有服務就重啟。沒有 launchd 服務時會裝在 `runner/` 目錄本身（可用 `YANROKU_DIR=/path` 指定別處）。

想手動編譯（等同 `CLAUDE.md` 裡的指令）：

```sh
cd ~/yanroku/runner
mkdir -p lib && cp "$(go list -m -f '{{.Dir}}' github.com/k2-fsa/sherpa-onnx-go-macos)"/lib/aarch64-apple-darwin/lib{sherpa-onnx-c-api,onnxruntime}.dylib lib/ && chmod u+w lib/*
go build -ldflags '-extldflags "-Wl,-rpath,@executable_path/lib"' -o yanroku .
./yanroku models
```

`yanroku` 要跟 `lib/` 放在一起。先前景跑一次確認連得上（Ctrl-C 結束）：

```sh
./yanroku run
```

其他子指令：`./yanroku ingest <folder>`（批次上傳資料夾裡的音訊）、`./yanroku version`。

### 4.4 用 launchd 常駐

在 `runner/` 目錄（已有 `./yanroku` 和 `.env`）：

```sh
sh install-launchd.sh
```

它會產生 `~/Library/LaunchAgents/ai.3mi.yanroku-runner.plist` 並啟動，log 在 `data/logs/runner.log`。常用指令：

```sh
launchctl kickstart -k gui/$(id -u)/ai.3mi.yanroku-runner   # 重啟（改完 .env 後）
launchctl bootout gui/$(id -u)/ai.3mi.yanroku-runner        # 停用
tail -f ~/yanroku/runner/data/logs/runner.log
```

注意：
- 這是 LaunchAgent（以登入使用者身分跑），`claude login` 的憑證才讀得到。Mac 要保持登入，並在「系統設定 → 能源」關掉自動睡眠。
- 多台 Mac 可以同時跑，工作用 lease 分配，不會重複處理。網頁的 runner 狀態會顯示每台的版本和是否在線。
- 專案和 `DATA_DIR` 放內建磁碟（APFS）。exFAT 外接碟會產生 `._*` 檔，讓 git 出錯。

### 4.5 用你自己的 AI 訂閱（Claude Code 或 Codex）

逐字稿整理、標題、摘要和 Ask 不需要另外申請 API key：runner 透過 [ACP](https://agentclientprotocol.com)（Agent Client Protocol）呼叫你 Mac 上已登入的 Claude Code 或 Codex，用的是你本來就付的 Claude 或 ChatGPT 訂閱額度，不會再多一張 API 帳單。

這只負責「文字」的部分。語音轉文字（whisper.cpp 或 Groq）和分講者（sherpa-onnx）是另外的，不經過 Claude 或 Codex。

**Claude Code（預設）**，需要 Claude Pro / Max 等可用 Claude Code 的方案：

```sh
npm i -g @agentclientprotocol/claude-agent-acp
claude login        # 沒有 claude 指令的話：npm i -g @anthropic-ai/claude-code
```

```sh
# runner/.env
ACP_AGENT=claude-agent-acp
ACP_MODEL=opus      # 模型別名，例如 opus、sonnet
```

**Codex**，需要 ChatGPT 方案（Plus / Pro 等）：

```sh
npm i -g @openai/codex
codex login         # 用 ChatGPT 帳號登入
```

```sh
# runner/.env（adapter 由 npx 在第一次呼叫時下載）
ACP_AGENT=npx -y @zed-industries/codex-acp -c model=gpt-5.5
```

Codex 的模型寫在 `ACP_AGENT` 的 `-c model=...`，`ACP_MODEL` 對它沒有作用。請指定 adapter 支援的模型：目前測過 adapter 0.16.0 搭配 `gpt-5.5` 可用，gpt-6 系列會被這版 adapter 拒絕。

速度參考（同一段短提示）：Claude Code 每次約 3 秒，Codex 約 11 秒。整理一份長逐字稿會分成多次呼叫，Codex 總時間會明顯比較久，但不影響結果。

改完 `.env` 要重啟 runner（`launchctl kickstart -k gui/$(id -u)/ai.3mi.yanroku-runner`）。

**疑難排解**

| 症狀 | 處理 |
|---|---|
| 摘要／整理失敗，log 提到未登入、auth、401 | agent 沒登入或登入過期。用跑 runner 的同一個使用者執行 `claude login` 或 `codex login`，再重啟 runner |
| log 提到 model not supported / 模型不存在 | 該 agent 或 adapter 不支援你指定的模型。Codex 換 `-c model=` 成 adapter 支援的模型（例如 `gpt-5.5`）；Claude Code 換 `ACP_MODEL`（例如 `sonnet`） |
| `ACP agent ...: executable file not found` | `claude-agent-acp` 或 `npx` 不在 launchd 的 PATH；確認已安裝，並用 `install-launchd.sh` 重裝服務 |
| 訂閱用量到上限 | 等額度恢復，或暫時把 `ACP_AGENT` 換成另一個 agent |

---

## 5. 連上 iOS App（或瀏覽器）

**iOS App**：用 Yanroku App（ https://yanroku.app ），第一次打開選 **「連線到自己的伺服器」** → 輸入 `https://notes.your-domain.com` → App 會開 Access 登入頁，用第 3 步允許的 email 登入（One-time PIN 或 Google）。登入有效期是 Access 的 Session Duration，過期會再請你登入，上傳佇列會暫停到你重新登入。

**瀏覽器**：Safari / Chrome 開 `https://notes.your-domain.com`，登入後可「加入主畫面」，直接在網頁錄音。

---

## 6. 更新

更新前先備份 D1（migrations 不能倒回）：

```sh
cd ~/yanroku/web
npx wrangler d1 export yanroku --remote --output backup-$(date +%Y%m%d).sql --env mine
```

然後：

```sh
cd ~/yanroku && git pull
cd web && npm install
npx wrangler d1 migrations apply yanroku --remote --env mine   # 先套 migrations
npx wrangler deploy --env mine                                 # 再部署 Worker
~/yanroku/runner/deploy.sh                                       # 每台 Mac 都跑一次
```

順序是 migrations → Worker → runner：新版 Worker 可能需要新欄位，新版 runner 可能需要新 API。

---

## 7. 疑難排解

| 症狀 | 原因與處理 |
|---|---|
| API 回 503 `Access not configured` | `ACCESS_TEAM` / `ACCESS_AUD` 沒設，或改完沒 `npx wrangler deploy --env mine` |
| API 回 403 `{"detail":"forbidden"}` | Worker 驗 JWT 失敗：AUD 複製錯，或 team name 多打了 `.cloudflareaccess.com` |
| runner 拿到 HTML 登入頁 | `.env` 的 token 錯，或 token 沒加進 Service Auth policy |
| runner 啟動就結束：`yanroku: API_BASE is required` | `.env` 沒設 `API_BASE`（沒有預設值），填上你自己的 Worker 網址 |
| 網頁顯示 runner「離線」 | Mac 睡眠、登出，或 launchd 沒在跑：`launchctl print gui/$(id -u)/ai.3mi.yanroku-runner`，看 `data/logs/runner.log` |
| log 出現 `whisper-cli: not found` 之類 | launchd 的 PATH 沒有 `/opt/homebrew/bin`；用 `install-launchd.sh` 重裝（它會設好 PATH） |
| log 出現 `groq quota exhausted` | Groq 免費額度（每小時音訊秒數）用完。runner 會把轉錄放回佇列、暫停領 STT 工作，期間只做摘要，額度恢復後自動續跑；已完成的片段有快取不會重送。等待，或改 `STT_PROVIDER=local` |
| 轉錄失敗、磁碟空間不足 | 模型約 1.5 GB，處理中的音訊會暫存在 `DATA_DIR`。清出空間，或把 `DATA_DIR` 指到有空間的內建磁碟 |
| 執行 `./yanroku` 直接 `killed` | 用 `cp` 覆蓋了 macOS 跑過的 binary，會被 SIGKILL。改用 `runner/deploy.sh`（寫新檔再 `mv`），或手動 build 到新檔名再 `mv` |
| 找不到 `libsherpa-onnx-c-api.dylib` | `yanroku` 旁邊沒有 `lib/`；照 4.3 複製 dylib，或直接跑 `deploy.sh` |
| 摘要／整理失敗 | ACP agent 沒裝或登入過期（`claude login` / `codex login`），或模型不被支援；見 4.5 |
