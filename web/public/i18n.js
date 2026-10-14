// Yanroku UI strings. zh-Hant is the source language: every UI string in index.html is written in zh-Hant and passed
// through t(); the en / ja dictionaries below are keyed by that zh-Hant string. A missing key returns the zh source.
//
// API (on window.yanroku, which index.html and extensions extend — never replace it):
//   t(zh, vars)            translate; '{name}' placeholders are filled from vars; '{n|one|other}' picks a plural form
//   lang / locale          resolved UI language ('zh-Hant' | 'en' | 'ja') and its Intl locale ('zh-TW' | 'en-US' | 'ja-JP')
//   setLang(lang)          persist the choice in localStorage['yanroku.lang'] and reload
//   addMessages(lang, d)   merge more strings ({ zh: translation }) into a language; extensions call this for their own UI
//   applyI18n(root)        translate static markup: data-i18n (text), data-i18n-placeholder / -title / -aria-label / -content;
//                          the attribute value is the key, or empty to use the current text / attribute as the key
// Language: ?lang=xx (persisted) → localStorage['yanroku.lang'] → navigator.languages (zh* / ja* / en*) → 'en'.
// Debug: localStorage['yanroku.i18nDebug']='1' logs each missing key once.
(function(){
'use strict';
const LANGS=['zh-Hant','en','ja'];
const LOCALES={'zh-Hant':'zh-TW',en:'en-US',ja:'ja-JP'};
const KEY='yanroku.lang';
const store={get(k){try{return localStorage.getItem(k)}catch{return null}},set(k,v){try{localStorage.setItem(k,v)}catch{}}};

function norm(l){
  if(!l)return null;
  if(LANGS.includes(l))return l;
  if(/^zh/i.test(l))return 'zh-Hant';
  if(/^ja/i.test(l))return 'ja';
  if(/^en/i.test(l))return 'en';
  return null;
}
function resolve(){
  let q=null;
  try{q=new URLSearchParams(location.search).get('lang')}catch{}
  const fromQuery=norm(q);
  if(fromQuery){store.set(KEY,fromQuery);return fromQuery}
  const saved=store.get(KEY);
  if(LANGS.includes(saved))return saved;
  for(const l of navigator.languages||[navigator.language]){const n=norm(l);if(n)return n}
  return 'en';
}
const lang=resolve();
document.documentElement.lang=lang;

// [zh-Hant source, en, ja]; '' is a real translation (e.g. a fragment that the language does not need)
const ROWS=[
// shell
['Yanroku 言錄 — 個人語音筆記：錄音與匯入音訊，自動轉成分講者的逐字稿與摘要。','Yanroku — personal voice notes: record or import audio and get transcripts with speakers, plus summaries.','Yanroku — 個人の音声メモ：録音や音声のインポートから、話者付きの文字起こしと要約を自動で作成。'],
['重新整理','Reload','再読み込み'],
['言錄','',''],
['YANROKU · 言錄','YANROKU','YANROKU'],
['錄音','Record','録音'],
['匯入','Import','インポート'],
['搜尋','Search','検索'],
['搜尋標題或逐字稿內容','Search titles and transcripts','タイトルや文字起こしを検索'],
['錄音清單','Recordings','録音一覧'],
['資料夾','Folders','フォルダ'],
['目前位置','Current location','現在の場所'],
['放開以匯入音訊或影片','Drop to import audio or video','ドロップして音声・動画をインポート'],
['載入中…','Loading…','読み込み中…'],
['重試','Retry','再試行'],
['關閉','Close','閉じる'],
['取消','Cancel','キャンセル'],
['儲存','Save','保存'],
['確定','OK','OK'],
['刪除','Delete','削除'],
['複製','Copy','コピー'],
['編輯','Edit','編集'],
['已複製','Copied','コピーしました'],
['已儲存','Saved','保存しました'],
['、',', ','、'],
['：',': ','：'],
['」「','”, “','」「'],
['{action}「{term}」','{action} “{term}”','{action}「{term}」'],
// status
['上傳中','Uploading','アップロード中'],
['排隊中','Queued','待機中'],
['轉檔中','Converting','変換中'],
['轉錄中','Transcribing','文字起こし中'],
['整理中','Cleaning up','整形中'],
['完成','Done','完了'],
['錯誤','Error','エラー'],
['產生中','Generating','生成中'],
['思考中','Thinking','考え中'],
// errors
['網路錯誤，無法連線到伺服器','Network error: can’t reach the server','ネットワークエラー：サーバーに接続できません'],
['網路錯誤','Network error','ネットワークエラー'],
['伺服器回應格式錯誤','Unexpected server response','サーバーの応答形式が正しくありません'],
['已中止','Aborted','中止しました'],
['登入已過期','Session expired','ログインの有効期限が切れました'],
['登入已過期或沒有權限（{status}），請重新整理頁面以重新登入。','Your session expired or you don’t have access ({status}). Reload the page to sign in again.','ログインの有効期限切れ、または権限がありません（{status}）。ページを再読み込みしてログインし直してください。'],
['服務暫時無法使用（503）：{msg}，請稍後重新整理。','Service temporarily unavailable (503): {msg}. Please reload later.','サービスが一時的に利用できません（503）：{msg}。しばらくしてから再読み込みしてください。'],
['服務暫時無法使用（503），請稍後重新整理。','Service temporarily unavailable (503). Please reload later.','サービスが一時的に利用できません（503）。しばらくしてから再読み込みしてください。'],
['錯誤：{msg}','Error: {msg}','エラー：{msg}'],
['未知錯誤','Unknown error','不明なエラー'],
['無法載入：{msg}','Couldn’t load: {msg}','読み込めません：{msg}'],
['無法載入 {src}','Couldn’t load {src}','{src} を読み込めません'],
['擴充元件無法載入：{msg}','An extension failed to load: {msg}','拡張機能を読み込めません：{msg}'],
// runners
['Runner 狀態','Runner status','ランナーの状態'],
['Runner 是在 Mac 上處理轉文字、分辨說話者與摘要的程式。沒有 runner 在線時，新的錄音會排隊，等 runner 上線後自動處理。','The runner is the program on a Mac that transcribes, tells speakers apart and writes summaries. While no runner is online, new recordings wait in the queue and are processed once one comes online.','ランナーは Mac 上で文字起こし・話者の識別・要約を行うプログラムです。オンラインのランナーがないあいだ、新しい録音は待機し、ランナーがオンラインになると自動で処理されます。'],
['目前沒有 runner 在線，會等 runner 上線後自動處理。','No runner is online. It will be processed once a runner comes online.','オンラインのランナーがありません。ランナーがオンラインになると自動で処理されます。'],
['剛剛','just now','たった今'],
['版本未知（舊版）','Unknown version (old)','バージョン不明（旧版）'],
['這台 runner 還沒更新到會回報版本的版本','This runner is older than the builds that report their version','このランナーはバージョンを報告しない古いビルドです'],
['需要更新','Update needed','要更新'],
['離線 · 最後連線 {ago}','Offline · last seen {ago}','オフライン · 最終接続 {ago}'],
['閒置，等待工作','Idle, waiting for work','待機中（ジョブ待ち）'],
['處理中：#{id}「{title}」· {status}','Processing #{id} “{title}” · {status}','処理中：#{id}「{title}」· {status}'],
['回答提問：「{title}」','Answering “{title}”','質問に回答中：「{title}」'],
['分析詞彙','Analyzing vocabulary','語彙を分析中'],
['產生摘要：#{id}「{title}」','Summarizing #{id} “{title}”','要約を生成中：#{id}「{title}」'],
['本機 Whisper','Local Whisper','ローカル Whisper'],
['移除 {name}','Remove {name}','{name} を削除'],
['從清單移除（重新連線時會自動出現）','Remove from the list (it reappears when it reconnects)','一覧から削除（再接続すると自動的に戻ります）'],
['{n} 台 runner 在線','{n} {n|runner|runners} online','ランナー {n} 台オンライン'],
['沒有 runner 在線','No runner online','オンラインのランナーなし'],
['排隊 {n}','{n} queued','待機 {n}'],
['排隊中：{r} 份錄音、{s} 份摘要、{a} 個提問','Queued: {r} {r|recording|recordings}, {s} {s|summary|summaries}, {a} {a|question|questions}','待機中：録音 {r} 件、要約 {s} 件、質問 {a} 件'],
['、詞彙分析',', vocabulary analysis','、語彙の分析'],
['還沒有 runner 連線過。','No runner has connected yet.','まだランナーが接続したことはありません。'],
// navigation, folders
['最近','Recent','最近'],
['全部','All','すべて'],
['未分類','Unfiled','未分類'],
['垃圾桶','Trash','ゴミ箱'],
['問問看','Ask','質問する'],
['設定','Settings','設定'],
['新增資料夾','New folder','新しいフォルダ'],
['尚無資料夾','No folders yet','フォルダはまだありません'],
['收合 {name}','Collapse {name}','{name} を折りたたむ'],
['展開 {name}','Expand {name}','{name} を展開'],
['「{name}」的動作','Actions for “{name}”','「{name}」の操作'],
['新增子資料夾','New subfolder','サブフォルダを作成'],
['重新命名','Rename','名前を変更'],
['資料夾名稱','Folder name','フォルダ名'],
['移動到…','Move to…','移動…'],
['移動「{name}」到','Move “{name}” to','「{name}」の移動先'],
['最上層','Top level','最上位'],
['刪除資料夾「{name}」及其 {n} 個子資料夾？','Delete folder “{name}” and its {n} {n|subfolder|subfolders}?','フォルダ「{name}」とサブフォルダ {n} 個を削除しますか？'],
['刪除資料夾「{name}」？','Delete folder “{name}”?','フォルダ「{name}」を削除しますか？'],
['其中 {n} 筆錄音會移到「未分類」（不會刪除）。','{n} {n|recording|recordings} in it will move to “Unfiled” (not deleted).','中の録音 {n} 件は「未分類」に移動します（削除はされません）。'],
['已刪除資料夾','Folder deleted','フォルダを削除しました'],
['在「{name}」中新增資料夾','New folder in “{name}”','「{name}」に新しいフォルダを作成'],
['新資料夾名稱','New folder name','新しいフォルダ名'],
['不能移到自己或子資料夾內','Can’t move a folder into itself or its subfolders','フォルダ自身やそのサブフォルダには移動できません'],
['已移到「{name}」','Moved to “{name}”','「{name}」に移動しました'],
['移到資料夾','Move to folder','フォルダに移動'],
['還沒有資料夾，可在左側「資料夾」旁按 + 新增。','No folders yet. Use the + next to “Folders” on the left to create one.','フォルダはまだありません。左側の「フォルダ」の横にある + で作成できます。'],
// list
['{n} 筆','{n} {n|item|items}','{n} 件'],
['無法載入清單：{msg}','Couldn’t load the list: {msg}','一覧を読み込めません：{msg}'],
['垃圾桶是空的','Trash is empty','ゴミ箱は空です'],
['找不到符合的錄音','No matching recordings','一致する録音はありません'],
['這裡沒有錄音','No recordings here','ここに録音はありません'],
['還沒有錄音，點「錄音」「匯入」或把檔案拖進視窗','No recordings yet. Click “Record” or “Import”, or drop files into the window.','録音はまだありません。「録音」「インポート」をクリックするか、ファイルをウィンドウにドロップしてください。'],
['等待額度','waiting for credits','クレジット待ち'],
['已有摘要','Has a summary','要約あり'],
['講話時間最多','Who spoke the most','発言時間が長い話者'],
// import, upload, record
['匯入 {n} 個檔案','Import {n} files','{n} 個のファイルをインポート'],
['匯入「{name}」','Import “{name}”','「{name}」をインポート'],
['開始上傳','Upload','アップロード開始'],
['上傳 {i}/{n}：{name}','Uploading {i}/{n}: {name}','アップロード中 {i}/{n}：{name}'],
['上傳：{name}','Uploading: {name}','アップロード中：{name}'],
['上傳失敗「{name}」：{msg}','Upload failed for “{name}”: {msg}','「{name}」のアップロードに失敗しました：{msg}'],
['下載錄音檔','Download the recording','録音ファイルをダウンロード'],
['已上傳 {n} 個檔案，排隊處理中','Uploaded {n} {n|file|files}, queued for processing','{n} 個のファイルをアップロードしました。処理を待っています'],
['這個瀏覽器不支援錄音','This browser can’t record audio','このブラウザは録音に対応していません'],
['無法使用麥克風：{msg}','Can’t use the microphone: {msg}','マイクを使用できません：{msg}'],
['捨棄這段錄音？','Discard this recording?','この録音を破棄しますか？'],
['錄音中','Recording','録音中'],
['錄音時請保持此頁面開啟，停止後會自動上傳。','Keep this page open while recording. It uploads automatically when you stop.','録音中はこのページを開いたままにしてください。停止すると自動でアップロードされます。'],
['語言','Language','言語'],
['捨棄','Discard','破棄'],
['停止並上傳','Stop and upload','停止してアップロード'],
['轉錄語言','Transcription language','文字起こしの言語'],
['中文','Chinese','中国語'],
['English','English','英語'],
['日本語','Japanese','日本語'],
['自動偵測','Detect automatically','自動検出'],
// routing, hero
['找不到這個資料夾','Folder not found','フォルダが見つかりません'],
['把聲音，','Turn your voice','声を、'],
['變成可以','into notes you can ',''],
['翻閱','flip through','読み返せる'],
['的筆記','','ノートに'],
['錄音或匯入音訊、影片，自動轉成逐字稿、分出每位講者，再整理成摘要。點任何一句話，就從那裡開始播放。','Record or import audio and video. Yanroku transcribes it, tells the speakers apart and writes a summary. Click any sentence to play from there.','録音するか音声・動画をインポートすると、自動で文字起こしして話者を分け、要約にまとめます。どの文をクリックしても、そこから再生できます。'],
['開始錄音','Start recording','録音を開始'],
['匯入檔案','Import files','ファイルをインポート'],
['多個檔案一次拖進視窗','drop several files into the window at once','複数のファイルをまとめてウィンドウにドロップ'],
['轉錄','Transcribe','文字起こし'],
['在 Mac 上分辨講者與時間','speakers and timing worked out on a Mac','Mac 上で話者とタイミングを識別'],
['閱讀','Read','読む'],
['逐字稿同步播放、產生摘要','transcript plays in sync, summaries on demand','文字起こしと同期再生、要約を生成'],
// detail
['找不到這筆錄音。','Recording not found.','録音が見つかりません。'],
['回到清單','Back to the list','一覧に戻る'],
['點擊重新命名','Click to rename','クリックして名前を変更'],
['標題','Title','タイトル'],
['還原','Restore','復元'],
['已還原','Restored','復元しました'],
['永久刪除','Delete permanently','完全に削除'],
['永久刪除「{title}」？此動作無法復原。','Permanently delete “{title}”? This can’t be undone.','「{title}」を完全に削除しますか？この操作は取り消せません。'],
['已永久刪除','Permanently deleted','完全に削除しました'],
['重新轉錄','Re-transcribe','再文字起こし'],
['會覆蓋目前的逐字稿與講者名稱。','This replaces the current transcript and speaker names.','現在の文字起こしと話者名は上書きされます。'],
['已排入重新轉錄','Queued for re-transcription','再文字起こしを予約しました'],
['移到資料夾…','Move to folder…','フォルダに移動…'],
['移到垃圾桶','Move to Trash','ゴミ箱に移動'],
['已移到垃圾桶','Moved to Trash','ゴミ箱に移動しました'],
['更多動作','More actions','その他の操作'],
['這筆錄音在垃圾桶中。','This recording is in the Trash.','この録音はゴミ箱にあります。'],
['處理失敗：{msg}','Processing failed: {msg}','処理に失敗しました：{msg}'],
['排隊中：{note}，預計 {time} 後繼續。','Queued: {note}. Resumes after {time}.','待機中：{note}。{time} 以降に再開します。'],
['排隊中：{note}。','Queued: {note}.','待機中：{note}。'],
['排隊中。','Queued. ','待機中。'],
['排隊中…','Queued…','待機中…'],
['處理中：{status}…（完成後會自動更新）','Processing: {status}… (this page updates when it’s done)','処理中：{status}…（完了すると自動で更新されます）'],
['逐字稿','Transcript','文字起こし'],
['摘要','Summary','要約'],
// player
['播放','Play','再生'],
['暫停','Pause','一時停止'],
['播放位置','Playback position','再生位置'],
['播放速度','Playback speed','再生速度'],
['音檔暫時無法播放，請稍後再試','The audio can’t be played right now. Try again later.','音声を再生できません。しばらくしてからもう一度お試しください'],
['倒退 15 秒','Back 15 seconds','15 秒戻る'],
['快轉 15 秒','Forward 15 seconds','15 秒進む'],
['5 秒','5 s','5 秒'],
// transcript
['逐字稿產生中…','Transcribing…','文字起こし中…'],
['沒有逐字稿內容。','The transcript is empty.','文字起こしの内容がありません。'],
['（我）',' (me)','（自分）'],
['未知講者','Unknown speaker','不明な話者'],
['聲紋相似度 {score}','Voiceprint similarity {score}','声紋の類似度 {score}'],
['可能是 {name}？','Is this {name}?','{name} さん？'],
['確認是 {name}','Yes, it’s {name}','{name} さんで確定'],
['不是','No','違う'],
['講者發言比例','Speaking time by speaker','話者ごとの発言割合'],
['正在檢視原始逐字稿','Viewing the raw transcript','元の文字起こしを表示中'],
['逐字稿已整理','Transcript cleaned up','文字起こしは整形済み'],
['檢視整理後','View cleaned up','整形後を表示'],
['檢視原文','View original','元の文を表示'],
['從 {time} 播放','Play from {time}','{time} から再生'],
['講者：{name}，點擊重新命名','Speaker: {name}. Click to rename','話者：{name}（クリックして名前を変更）'],
['（依聲紋自動辨識）',' (identified by voiceprint)','（声紋で自動識別）'],
['自動','Auto','自動'],
['依聲紋自動辨識，點擊可更正','Identified automatically by voiceprint. Click to correct','声紋で自動識別されました。クリックして修正できます'],
['編輯文字','Edit text','テキストを編集'],
['複製文字','Copy text','テキストをコピー'],
// speaker dialog
['講者名稱','Speaker name','話者名'],
['名稱','Name','名前'],
['最近使用','Recently used','最近使用'],
['套用到','Apply to','適用範囲'],
['僅此段落','This segment only','この段落のみ'],
['此講者的所有段落','All segments by this speaker','この話者のすべての段落'],
['尚無紀錄','None yet','履歴はありません'],
// copy as prompt
['預覽 Prompt','Preview prompt','プロンプトをプレビュー'],
['Prompt 內容','Prompt text','プロンプトの内容'],
['下載 .md','Download .md','.md をダウンロード'],
['無','None','なし'],
['請根據內容回答問題','Answer questions about it','内容について質問に答えて'],
['以下是一份錄音的摘要與逐字稿，請根據內容回答我接下來的問題。','Below are the summary and transcript of a recording. Answer my next questions based on its content.','以下はある録音の要約と文字起こしです。この内容に基づいて、次の質問に答えてください。'],
['請整理待辦與決議','List action items and decisions','ToDo と決定事項をまとめて'],
['以下是一份會議錄音的逐字稿，請整理出所有待辦事項（負責人、內容、期限）與會議中做出的決定。','Below is the transcript of a meeting recording. List every action item (owner, task, due date) and every decision made in the meeting.','以下は会議の録音の文字起こしです。すべての ToDo（担当者、内容、期限）と、会議での決定事項をまとめてください。'],
['自訂…','Custom…','カスタム…'],
['日期：','Date: ','日付：'],
['長度：','Length: ','長さ：'],
['片段：','Excerpt: ','抜粋：'],
['參與者：','Participants: ','参加者：'],
['來源：','Source: ','出典：'],
['摘要（{name}）','Summary ({name})','要約（{name}）'],
['約 {chars} 字 · ~{tokens} tokens','About {chars} characters · ~{tokens} tokens','約 {chars} 文字 · ~{tokens} トークン'],
['內容很長，有些模型一次放不下，可只複製摘要或一段','This is long; some models can’t take it all at once. Copy just the summary or a part.','内容が長く、一度に入りきらないモデルもあります。要約や一部だけをコピーできます'],
['已複製為 Prompt（{est}）','Copied as a prompt ({est})','プロンプトとしてコピーしました（{est}）'],
['已複製為 Prompt','Copied as a prompt','プロンプトとしてコピーしました'],
['例如：請用三點整理重點，並列出我需要追蹤的事。','e.g. Sum up the key points in three bullets and list what I need to follow up on.','例：要点を3つにまとめ、私がフォローすべきことを挙げてください。'],
['自訂指示語','Custom instructions','カスタム指示'],
['開頭指示語','Opening instruction','冒頭の指示'],
['複製選項','Copy options','コピーのオプション'],
['包含摘要','Include summaries','要約を含める'],
['包含逐字稿','Include transcript','文字起こしを含める'],
['時間戳','Timestamps','タイムスタンプ'],
['使用原始辨識文字（未整理）','Use the raw recognized text (not cleaned up)','元の認識テキストを使う（整形なし）'],
['預覽','Preview','プレビュー'],
['複製為可貼到 ChatGPT / Claude 的 Prompt','Copy as a prompt to paste into ChatGPT / Claude','ChatGPT / Claude に貼り付けられるプロンプトとしてコピー'],
['複製為 Prompt','Copy as prompt','プロンプトとしてコピー'],
['複製這段為 Prompt','Copy this part as prompt','この部分をプロンプトとしてコピー'],
// summaries
['產生摘要','Generate summary','要約を生成'],
['範本','Template','テンプレート'],
['會議摘要','Meeting summary','会議の要約'],
['逐字稿完成後才能產生摘要。','A summary can be generated once the transcript is done.','文字起こしが完了すると要約を生成できます。'],
['複製摘要','Copy summary','要約をコピー'],
['刪除摘要','Delete summary','要約を削除'],
['刪除這份摘要？','Delete this summary?','この要約を削除しますか？'],
['產生中，請稍候…','Generating, please wait…','生成中です。しばらくお待ちください…'],
['產生失敗','Generation failed','生成に失敗しました'],
['還沒有摘要。','No summaries yet.','要約はまだありません。'],
// ask
['志明上個月答應了什麼？','What did John promise last month?','佐藤さんは先月何を約束しましたか？'],
['客戶在哪幾場會議提過價格？','In which meetings did the client bring up pricing?','顧客が価格に触れたのはどの会議ですか？'],
['找不到這個提問。','Question not found.','この質問が見つかりません。'],
['還沒有提問','No questions yet','質問はまだありません'],
['問所有錄音，例如：{q}','Ask across all recordings, e.g. {q}','すべての録音に質問できます。例：{q}'],
['問題','Question','質問'],
['送出','Ask','送信'],
['會先找出相關錄音，再讀逐字稿回答，每句都附出處。','Finds the relevant recordings, reads their transcripts and answers with a source for every sentence.','関連する録音を探して文字起こしを読み、出典付きで回答します。'],
['跨錄音提問','Ask across recordings','録音を横断して質問'],
['試試：','Try:','例：'],
['複製回答','Copy answer','回答をコピー'],
['刪除提問','Delete question','質問を削除'],
['刪除這個提問？','Delete this question?','この質問を削除しますか？'],
['思考中：正在找出相關錄音、閱讀逐字稿…','Thinking: finding relevant recordings and reading transcripts…','考え中：関連する録音を探して文字起こしを読んでいます…'],
['回答失敗：{msg}','Couldn’t answer: {msg}','回答に失敗しました：{msg}'],
['參考錄音','Sources','参照した録音'],
['錄音 #{id}','Recording #{id}','録音 #{id}'],
['（在垃圾桶）','(in Trash) ','（ゴミ箱内）'],
// settings
['介面','Interface','表示'],
['介面語言','Interface language','表示言語'],
['關於我','About me','自分について'],
['職稱、領域、錄音用途','Job title, field, what you record','役職、分野、録音の用途'],
['內容重點','Focus','内容の重点'],
['自訂指示','Custom instructions','カスタム指示'],
['只用於產生摘要。','Used only for summaries.','要約の生成にのみ使われます。'],
['語言與逐字稿','Language & transcript','言語と文字起こし'],
['預設轉錄語言','Default transcription language','既定の文字起こし言語'],
['自動整理逐字稿（錯字、標點）','Clean up transcripts automatically (typos, punctuation)','文字起こしを自動で整形（誤字・句読点）'],
['講者','Speakers','話者'],
['依聲紋自動標記講者','Label speakers automatically by voiceprint','声紋で話者を自動ラベル付け'],
['我是誰','Who am I','自分はどの話者か'],
['（未設定）','(not set)','（未設定）'],
['講者（改名、刪除立即生效）','Speakers (renames and deletions apply immediately)','話者（名前の変更・削除はすぐに反映）'],
['詞彙','Vocabulary','語彙'],
['建議加入（加入、忽略立即生效）','Suggested terms (Add and Ignore apply immediately)','追加の候補（追加・無視はすぐに反映）'],
['專有名詞，Enter 或逗號加入','Proper nouns; press Enter or type a comma to add','固有名詞（Enter またはカンマで追加）'],
['新增詞彙','Add term','語彙を追加'],
['通知','Notifications','通知'],
['完成時通知我','Notify me when it’s done','完了したら通知'],
['送測試通知','Send test notification','テスト通知を送信'],
['iPhone 需先「加入主畫面」再從主畫面開啟才能收到通知','On iPhone, “Add to Home Screen” first and open Yanroku from the Home Screen to get notifications','iPhone では「ホーム画面に追加」してから、ホーム画面から開くと通知を受け取れます'],
['設定只影響之後的新工作；既有錄音可重新轉錄或重新產生摘要。','Settings apply to new jobs only; you can re-transcribe or re-summarize existing recordings.','設定はこれからの処理にのみ反映されます。既存の録音は再文字起こしや要約の再生成ができます。'],
['有未儲存的變更','You have unsaved changes','未保存の変更があります'],
['放棄','Discard','破棄'],
['繼續編輯','Keep editing','編集を続ける'],
['有未儲存的變更，切換語言會放棄這些變更。要繼續嗎？','You have unsaved changes. Switching the language discards them. Continue?','未保存の変更があります。言語を切り替えると変更は破棄されます。続けますか？'],
['已儲存設定','Settings saved','設定を保存しました'],
['無法儲存：{msg}','Couldn’t save: {msg}','保存できません：{msg}'],
['「{w}…」超過 50 字','“{w}…” is longer than 50 characters','「{w}…」は 50 文字を超えています'],
['詞彙最多 200 個','Up to 200 terms','語彙は最大 200 個です'],
['移除 {name}','Remove {name}','{name} を削除'],
['用於語音辨識、逐字稿整理與摘要。沒有詞彙就不使用。','Used for speech recognition, transcript cleanup and summaries. Not used when empty.','音声認識、文字起こしの整形、要約に使われます。空なら使われません。'],
['{m} 個詞都會送進語音辨識','All {m} {m|term goes|terms go} to speech recognition','{m} 個すべてが音声認識に使われます'],
['前 {n} 個詞會送進語音辨識，其餘 {rest} 個只用於整理與摘要','The first {n} {n|term goes|terms go} to speech recognition; the other {rest} only to cleanup and summaries','最初の {n} 個は音声認識に、残りの {rest} 個は整形と要約にのみ使われます'],
['還沒有建議。累積更多錄音後會自動分析。','No suggestions yet. They appear automatically as you add recordings.','候補はまだありません。録音が増えると自動で分析されます。'],
['分析中…','Analyzing…','分析中…'],
['上次分析失敗：{msg}','Last analysis failed: {msg}','前回の分析に失敗しました：{msg}'],
['上次分析：{time}','Last analyzed: {time}','前回の分析：{time}'],
['立即分析','Analyze now','今すぐ分析'],
['出現 {n} 次','{n} {n|time|times}','{n} 回出現'],
['{n} 份錄音','{n} {n|recording|recordings}','録音 {n} 件'],
['曾被聽成「{list}」','heard as “{list}”','「{list}」と誤認識'],
['加入','Add','追加'],
['忽略','Ignore','無視'],
['無法載入講者：{msg}','Couldn’t load speakers: {msg}','話者を読み込めません：{msg}'],
['還沒有講者。在逐字稿中為講者命名後會出現在這裡。','No speakers yet. Name a speaker in a transcript and they show up here.','話者はまだいません。文字起こしで話者に名前を付けるとここに表示されます。'],
['{n} 個聲紋','{n} {n|voiceprint|voiceprints}','声紋 {n} 件'],
['{n} 位講者','{n} {n|speaker|speakers}','話者 {n} 人'],
['改名','Rename','名前を変更'],
['「{name}」的新名稱','New name for “{name}”','「{name}」の新しい名前'],
['「{name}」已存在，要合併嗎？','“{name}” already exists. Merge them?','「{name}」はすでに存在します。統合しますか？'],
['合併','Merge','統合'],
['刪除「{name}」？{n} 個聲紋會一併刪除','Delete “{name}”? Their {n} {n|voiceprint|voiceprints} will be deleted too','「{name}」を削除しますか？声紋 {n} 件も削除されます'],
['通知權限被封鎖，請到瀏覽器或系統設定允許 Yanroku 通知','Notifications are blocked. Allow Yanroku notifications in your browser or system settings.','通知がブロックされています。ブラウザまたはシステムの設定で Yanroku の通知を許可してください'],
['已開啟通知','Notifications on','通知をオンにしました'],
['已送出測試通知','Test notification sent','テスト通知を送信しました'],
// shown as-is from the Worker (HttpError messages) and the runner (queue notes)
['詞彙已滿 200 個，請先移除一些再加入','The vocabulary is full (200 terms). Remove some before adding more.','語彙が上限の 200 個に達しています。いくつか削除してから追加してください'],
['已在分析中','Already analyzing','すでに分析中です'],
['沒有新的錄音可以分析','No new recordings to analyze','分析できる新しい録音はありません'],
['等待 Groq 免費額度恢復','waiting for the Groq free quota to reset','Groq の無料枠の回復待ち'],
['runner 已停止，重新排隊','the runner stopped; queued again','ランナーが停止したため再度待機中'],
];

const M={'zh-Hant':{},en:{},ja:{}};
for(const [zh,en,ja] of ROWS){M.en[zh]=en;M.ja[zh]=ja}

const debug=(()=>{try{return !!localStorage.getItem('yanroku.i18nDebug')}catch{return false}})();
const seen=new Set();
function fill(s,vars){
  if(!vars)return s;
  return s.replace(/\{(\w+)\|([^|}]*)\|([^}]*)\}/g,(m,k,one,other)=>k in vars?(Number(vars[k])===1?one:other):m)
    .replace(/\{(\w+)\}/g,(m,k)=>k in vars&&vars[k]!=null?String(vars[k]):m);
}
function t(zh,vars){
  if(zh==null)return '';
  zh=String(zh);
  const d=M[lang];
  let s=d&&Object.prototype.hasOwnProperty.call(d,zh)?d[zh]:null;
  if(s==null){
    s=zh;
    if(debug&&lang!=='zh-Hant'&&/[㐀-鿿]/.test(zh)&&!seen.has(zh)){seen.add(zh);console.warn('[i18n] missing '+lang+':',zh)}
  }
  return fill(s,vars);
}
function setLang(l){
  l=norm(l);if(!l)return;
  store.set(KEY,l);
  // drop ?lang= so it doesn't override the new choice on reload
  try{const u=new URL(location.href);if(u.searchParams.has('lang')){u.searchParams.delete('lang');location.replace(u.href);return}}catch{}
  location.reload();
}
function addMessages(l,dict){
  l=norm(l);if(!l||!dict)return;
  Object.assign(M[l],dict);
}
const ATTRS=['placeholder','title','aria-label','content'];
function applyI18n(root){
  root=root||document;
  for(const el of root.querySelectorAll('[data-i18n]')){
    let k=el.getAttribute('data-i18n');
    if(!k){k=el.textContent.trim();el.setAttribute('data-i18n',k)}
    el.textContent=t(k);
  }
  for(const a of ATTRS)for(const el of root.querySelectorAll('[data-i18n-'+a+']')){
    let k=el.getAttribute('data-i18n-'+a);
    if(!k){k=el.getAttribute(a)||'';el.setAttribute('data-i18n-'+a,k)}
    el.setAttribute(a,t(k));
  }
  // the web app manifest is per language (manifest.<lang>.webmanifest); zh-Hant keeps manifest.webmanifest
  const mf=document.querySelector('link[rel=manifest]');
  if(mf&&lang!=='zh-Hant')mf.setAttribute('href','/manifest.'+lang+'.webmanifest');
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>applyI18n());

const y=window.yanroku=window.yanroku||{};
Object.assign(y,{t,lang,locale:LOCALES[lang],langs:LANGS.slice(),setLang,addMessages,applyI18n});
})();
