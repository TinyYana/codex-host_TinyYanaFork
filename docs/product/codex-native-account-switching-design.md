# Codex 帳號切換的設計邊界

来源、贡献 lineage 与许可证统一记录在 [Credits / provenance](../../CREDITS.md)；本文维护当前行为与设计。

CodexHost 以「單一正式 `CODEX_HOME`、單一自有官方 backend、多份保存的 credential」提供全域 Codex 帳號切換。Account 是認證身分，不等於 Harness、Model、Provider 或 Billing Source；不建立 Model proxy、per-帳號 backend pool 或 per-Thread 帳號路由。

歷史脈絡：PR #117 做過 per-帳號 `CODEX_HOME` + runtime pool，被 PR #262 的原生全域切換取代；`f3592bdb` 曾把 Host 多帳號整個移除，只留唯讀額度頁（`openspec/changes/remove-codex-multi-account/`）。現行契約 `openspec/changes/add-codex-managed-accounts/` 取代了那次移除，範圍比 #262 窄：

- 不自己做登入。新增帳號＝官方 Desktop 登入後明確「保存目前帳號」；官方 `account/login/*`、`account/logout` 原樣轉發。
- 不為了切換終止任何非自有的 Codex 行程；偵測到共用同一個 home 的外部行程時，以 `unsafe-external-process` 明確拒絕。
- 沒有 vault 之前管理功能休眠，行為等同唯讀部署。
- 目前帳號永遠由 `auth.json` 推導，不持久化 selector；UI 只在官方 `account/read` 驗證新身分之後才更新。

行為、交易步驟、額度、Ranker、Auto 與 migration 見 [Codex 多帳號、額度 Ranking 與安全切換](codex-managed-accounts.md)；設定頁版面見 [帳號與額度設定](codex-accounts.md)。

Host 准备阶段只初始化原生身份读取连接，不主动预取账号；Desktop 接入已就绪的原生后端时，账号观察器只记录后端代次，不在 `initialize` 响应后额外读取账号或收集凭据，避免干扰官方认证与项目侧栏的初始化顺序。真实账号变更、登录完成和后端代次变化仍按原生事件处理（含凭据收集）。
