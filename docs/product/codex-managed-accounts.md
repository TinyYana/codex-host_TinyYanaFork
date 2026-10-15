# Codex 多帳號、額度 Ranking 與安全切換

来源、贡献 lineage 与许可证统一记录在 [Credits / provenance](../../CREDITS.md)；本文维护当前行为与设计。

CodexHost 可以管理多個 ChatGPT/Codex 帳號：保存、列出、並排看額度、手動或自動切換、刪除非目前帳號。全程不需要離開 CodexHost 去登出再登入。產品契約見 `openspec/changes/add-codex-managed-accounts/`；它取代了 `remove-codex-multi-account` 的「Host 不管多帳號」邊界。設定頁的版面與其他 Harness 唯讀列見 [帳號與額度設定](codex-accounts.md)。

Account 仍然只是認證身分，不等於 Harness、Model、Provider 或 Billing Source。這裡沒有 per-Thread 帳號路由、沒有 per-帳號 backend pool、沒有 Model proxy：整個 Host 同一時間只有一個目前 Codex 帳號。

## 怎麼用

1. **新增帳號**：先用官方 Codex Desktop 登入要加入的帳號，再到「設定 → 帳號」按「保存目前帳號」。CodexHost 不自己做登入（沒有 device-code login，也不開登入用的 app-server）；`account/login/*` 與 `account/logout` 照舊原樣交給官方後端。
2. **第二個帳號**：用官方登入換成另一個帳號，再按一次「保存目前帳號」。兩個帳號都在列表裡之後，就可以直接在 CodexHost 內切換。
3. **切換**：在設定頁的帳號列，或 Composer 旁的額度浮窗，選擇目標帳號。有 Turn 正在跑時會被拒絕（busy），等 Turn 結束再切。
4. **刪除**：只能刪除「已保存、且不是目前」的帳號。刪除只移除保存的副本，不會登出、不會動 `auth.json`。原生登出也不會刪掉保存的帳號。
5. **Auto**：預設是 Manual。開啟 Auto 後，Host 只會在 Turn 之間、依 Quota Ranker 的建議切換 Codex 帳號。

目前登入但還沒保存的帳號會照常顯示為目前帳號（身分來自官方 `account/read`），只是沒有「切回來」的副本。從未保存的帳號切走時，交易的第一步會先把它保存起來，所以不會因為切換而遺失登入。

## Credential 怎麼保存

- 位置：`<CODEX_HOME>/.codexhost-native-accounts/vault.json`（v3）。目錄 `0700`、檔案 `0600`，一律先寫暫存檔（`wx`）再 `rename`，不會留下寫到一半的檔案。
- 內容：每個帳號存一份**原生 `auth.json` 的完整原文**，逐位元組保留，包含 CodexHost 不認識的欄位。Host 只解 JWT claims 來建立「這份 credential 屬於誰」的關聯（`sub` + workspace），不驗簽，也不把它當成登入驗證——身分驗證永遠以官方後端的 `account/read` 為準。
- 不外流：token、`auth.json` 原文、原生檔案路徑都不會出現在 Renderer 契約、log、診斷檔或錯誤文字。錯誤一律是固定文案加上封閉的類別碼（`busy`、`unsafe-external-process`、`switch-failed`…）。診斷檔 `diagnostics.log` 只記步驟名稱、數字 RPC 碼與耗時。
- 只換 credential：切換只替換 `auth.json`。`config.toml`、session/history、MCP 設定、Model 設定完全不跟著帳號搬動。
- 不支援的儲存：API Key、`OPENAI_API_KEY` 等環境變數覆寫、keyring 型登入都不能保存或切換，會回 `unsupported-storage`。
- 在沒有 vault 之前，管理功能是休眠的：Host 不檢查 credential 儲存、不寫任何東西，行為與唯讀部署完全相同，直到使用者第一次保存帳號。

**目前帳號不持久化。** 誰是目前帳號，永遠由 `auth.json` 的身分去比對 vault 推導出來。使用者在外部重新登入、登出、或 token 被原生刷新，列表都會跟著 `auth.json` 走，不會出現「Host 記得的是 B、實際檔案是 A」。已保存帳號的副本會在被觀察到較新世代時更新；沒保存過的身分不會被被動收集。

## 切換是一筆受控交易

`NativeCodexAccounts.switch()`（`packages/host-runtime/src/account/native-codex-accounts.ts`）：

1. 檢查儲存型態（檔案型、無 API Key 覆寫）。
2. 取得 change lease：`OfficialWorkGate` 進入 `changing`，之後新進來的官方請求不會被 admit，而是等切換結束再轉發到新的 backend（最多 30 秒，逾時才以 `changing` 失敗）；Desktop 會把啟動檢查請求失敗視為致命錯誤而退出，所以不能立即拒絕。若有進行中的原生登入/登出，切換被拒絕。
3. **Turn 檢查**：gate 只知道 in-flight 請求，不知道 Turn。所以 lease 拿到之後，同步詢問 Turn 的擁有者（`AppServerHost` 透過 `bindIdleProbe` 提供 `#hasActiveWork()`）；有任何官方或外部 Turn 在跑就回 busy，backend 不會被停。
4. 保存目前最新的 credential。
5. **外部行程檢查**：偵測是否有其他 Codex 行程（例如終端機裡的 `codex` CLI）使用同一個 `CODEX_HOME`。有的話回 `unsafe-external-process`，**不終止任何行程**，此時什麼都還沒停、什麼都還沒寫。偵測是 best-effort（`ps`；讀得到環境變數時以 `CODEX_HOME` 判斷是否同一個 home；Windows 目前不偵測），偵測不到就放行，由第 9 步兜底。啟動這個 Host 的同一個 Desktop 實例底下、子命令為 `exec-server` 的 `codex`（Desktop 的 Local Work executor）不算外部行程：它只在啟動時讀取原生登入，之後持有固定的 bearer token，不會回寫 `auth.json`。切換後它仍以舊帳號連線，直到 Desktop 因故重啟它。
6. 停止自己擁有的 backend，等到退出證明。
7. 再保存一次目前 credential（backend 退出時可能剛好輪換了 token）。
8. 原子寫入目標 credential，並回讀比對。
9. 啟動 backend，以官方 `account/read` 輪詢（約每 200ms、上限 10 秒）加上 `auth.json` 身分比對來**驗證身分**。
10. 驗證成功後才把 phase 設回 `ready`、更新 current 與 UI。

失敗處理：啟動或驗證失敗就裝回原本的 credential、重啟、再驗證；若還沒寫入就失敗，則保留磁碟上可能已輪換的較新 credential。連 rollback 也失敗時，phase 變成 `unavailable`（`recovery-required`），設定頁提供「修復」。

防止 identity 分裂的幾個機制：

- **Late response / late notification**：每次 backend 啟動是一個新 generation。舊 generation 的在途請求由 `OfficialRuntimeOwner` 交回原本的請求 client（`-32001 retired`），不會更新切換後的狀態；舊 generation 的通知不會被投影。短的在途請求（例如額度讀取）不做 drain，直接 retire。
- **UI 不樂觀更新**：Renderer 只採用 Host 回傳的列表與 `codexhost/account/changed`，並用 `instanceId`/`revision` 版本閘擋掉舊快照。
- **並行切換**：第二個切換請求在第一個進行中時回 `changing`。
- **Host 重啟**：重啟後 current 由 `auth.json` 重新推導。

## 額度（Unified Quota）

跨層只有一種額度形狀：既有的 `AccountCreditsSnapshot`。沒有另外發明競爭的 quota 契約；其他 Harness 的 `inspectAccount()` → `codexhost/harness/accounts/*` 鏈路完全沒動，Claude Code、Antigravity、Grok 的唯讀列照舊。

- 目前帳號：官方 `account/rateLimits/read`（既有路徑與 15 秒快取）。讀到的 live 額度會順手記進保存帳號的快取，切走之後仍有「最後已知」的數字。
- 已保存、非目前帳號：`native-account-quotas.ts` 以該帳號自己的 credential 唯讀查詢 ChatGPT usage 端點，視窗長度對應 5h／7d，其他視窗保留為具名的 product 視窗（不丟、不合併）。access token 過期時，以 per-帳號 single-flight 方式刷新，並把新 token 寫回 vault 的那一份（保留未知欄位）。快取 5 分鐘、磁碟快取最長 6 小時、回應大小有上限。
- **unknown 就是 unknown**：查不到時回空的觀測（沒有百分比），UI 顯示「—」，不會補成已用 0% 或剩餘 100%。不同帳號、不同方案的百分比不會被加總。
- refresh token 被拒絕時，該帳號標為 `requiresLogin`，Ranker 不會自動選它。設定頁該列的「重新登入」會送出官方 `account/login/start`（`type: "chatgpt"`）並在瀏覽器開啟回傳的 `authUrl`；登入完成後原生 Codex 改用該帳號，Host 被動捕捉到新 grant 就解除標記，不必刪除重存。標記綁定被拒絕的那份 grant，換了新 grant 即失效。

`codexhost/account/usage/inspect {accountId}` 對任何已保存帳號都可用，所以設定頁能同時顯示每個帳號各自的 5h、7d 與重置時間。

## Quota Ranker

`packages/host-runtime/src/account/quota-ranker.ts` 是純函式、Harness-neutral 的一層：沒有 I/O、不讀時鐘、不依賴 Codex 型別，只吃 `AccountCreditsSnapshot`。`QuotaWindow {scope, period, usedPercent, resetsAt}` 是它**內部**的視圖，不是新的 wire 契約。

每個候選帳號推導：

| 推導 | 意義 |
| --- | --- |
| binding window | 帳號層級視窗中 headroom 最少的那個 |
| headroom | binding window 的剩餘百分比；重置時間已過的視窗視為已回滿 |
| reset deadline | 最長帳號層級視窗的重置時間 |
| health | credential 是否可用、額度是否已知且夠新（預設 15 分鐘內） |
| waste risk | 長視窗裡「快要重置卻還沒用掉」的比例（0–1） |

model/product 專屬的限制預設不參與帳號選擇（這一層不知道使用者在用哪個 Model）；未來的 ModelProfile/ModelRanker 可以透過 `bindsSelection` 把它們納入。Ranker 只回答額度與帳號問題，**不做任何 GPT/Claude/Gemini 品質分數**。

策略：

- `best`（預設）：headroom 加上 waste risk 的加成——避免撞牆，同時不讓快重置的剩餘額度白白過期。
- `consume-first`：集中使用消耗最多、但還沒撞牆的帳號，其他帳號留作儲備。
- `waste-first`：優先花掉最快過期的額度。

不會被自動選中的候選會被 quarantine 並附理由：`credential-unusable`、`quota-unknown`、`quota-stale`、`exhausted`（headroom ≤ 3%）。這些帳號仍可手動切換。

防 ping-pong：目前帳號只要還合格，挑戰者必須領先超過 hysteresis margin（預設 10 分）才會被建議；切換後 10 分鐘 cooldown 內維持目前帳號。目前帳號已撞牆時，這兩個限制不適用（留著就是撞牆）。手動切換也會啟動 cooldown，Auto 不會立刻把它切回去。

`codexhost/account/ranking/inspect` 回傳每個帳號的推導結果與人類可讀的理由，供 UI 解釋「為什麼建議這個帳號」。

## Auto 與 Switch & Retry

`packages/host-runtime/src/account/account-auto-switch.ts`。Auto 的模式（開關 + 策略）存在 Host 端的 `<CODEX_HOME>/.codexhost-native-accounts/auto-mode.json`。

- Auto 只能呼叫上面那筆標準切換交易，所以**結構上**它只會改變 Codex 帳號：Harness、Model、reasoning effort/profile、Provider 都不在它碰得到的範圍內，不會自動切到 Claude、Antigravity 或其他 Agent。
- 只在安全的 Turn boundary 評估：`AppServerHost` 在 active work 排空時觸發；評估最多每 60 秒一次；讀額度是非同步的，切換前會再確認一次仍然 idle。
- 切換被拒絕（busy、unsafe、失敗）時維持已驗證的目前帳號，下一個 boundary 再試。

**Switch & Retry**：Turn 因為額度撞牆而失敗、且 Ranker 顯示有其他合格帳號時，UI 提供明確的「切換帳號並重試」。它先執行切換交易；成功後，原本的輸入要由使用者**明確確認**才會重送成一個新的 Turn。Host 不會自動重放已經執行過部分工具操作的 Turn。撞牆的判斷不確定時，只提供手動切換、不提供重試。

## Migration

- 從未用過舊版多帳號：沒有 vault，什麼都不會發生，直到第一次「保存目前帳號」。
- 用過 0.8.x／0.9 的多帳號（磁碟上留有 `.codexhost-native-accounts/vault.json`，v1–v3）：Host 啟動時開啟它，之前保存的帳號會重新出現在列表。舊格式升級成 v3，同目錄下舊版遺留的登入／交易暫存檔會被清掉。credential 已無法辨識的項目保留為 `requiresLogin`。
- Thread、mapping-store、其他 Harness 的資料都沒有 schema 變更。
- Renderer 以 `capabilities` 決定要不要顯示管理動作；接到沒有 `capabilities` 的列表（SSH 遠端、舊 Host）時，設定頁維持原本的唯讀樣子。

## 限制

- SSH 遠端維持遠端原生單帳號，不傳輸本地 credential。
- 與外部工具共用 `auth.json` 時，檔案層級的切換無法對獨立的 client 做到原子；外部行程檢查、身分驗證與「current 由檔案推導」把後果限制在「一次明確失敗的切換」，而不是靜默分裂。
- ChatGPT usage 端點不是公開文件化的 API，形狀或頻率限制可能改變；解析寬鬆、失敗時退回帶時間戳的舊觀測。
- 重置卡仍然只顯示，CodexHost 不消耗。

## 實作與驗證

- `packages/shared-contracts/src/codex-accounts.ts`：browser-safe 契約（N 個帳號、`changing`、capabilities、auto、ranking）。
- `packages/host-runtime/src/account/native-account-store.ts`：vault 與 `auth.json` 的私有持久化邊界。
- `packages/host-runtime/src/account/native-codex-credentials.ts`：opaque credential 與身分關聯。
- `packages/host-runtime/src/account/native-codex-accounts.ts`：保存、切換交易、刪除、修復。
- `packages/host-runtime/src/account/official-account-runtime.ts`：backend 停啟、儲存檢查、身分驗證。
- `packages/host-runtime/src/account/external-codex-processes.ts`：外部 Codex 行程偵測（只偵測）。
- `packages/host-runtime/src/account/native-account-quotas.ts`：已保存帳號的唯讀額度。
- `packages/host-runtime/src/account/quota-ranker.ts`、`account-auto-switch.ts`：Ranker 與 Auto policy。
- `packages/host-runtime/src/codex-account-requests.ts`：`codexhost/account/*` 請求語意與錯誤類別。
- `packages/host-runtime/src/codex-runtime/official-work-gate.ts`：`changing` phase 與 change lease。
- `packages/host-runtime/src/native-account-host.ts`：本機組裝（管理功能休眠到有 vault 為止）。
- 測試：`packages/host-runtime/test/` 下的 `native-codex-accounts`（並行切換、Turn 進行中拒絕、驗證失敗 rollback、rollback 保留輪換後的 token、外部行程拒絕、重啟與 auth drift、明確保存）、`native-account-store`、`native-account-quotas`、`quota-ranker`（unknown、quarantine、ping-pong、cooldown、策略）、`account-auto-switch`、`codex-account-requests`、`official-runtime-owner`（generation retire）、`official-work-gate`。
