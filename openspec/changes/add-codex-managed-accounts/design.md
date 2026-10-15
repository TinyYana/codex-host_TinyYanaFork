# Design: Codex managed accounts, unified quota ranking, safe switching

## Context

Current main keeps a single canonical `CODEX_HOME`, one owned official backend (`OfficialRuntimeOwner`/`OfficialRuntimeScope`), a synchronous admission boundary (`OfficialWorkGate`, phases `ready`/`unavailable`), a read-only current identity (`SingleNativeCodexAccount` over `controlRequest("account/read")`), official quota via `account/rateLimits/read` with a 15s cache (`AccountRateLimits`), and read-only other-Harness quota via `inspectAccount()` → `codexhost/harness/accounts/*`. PR #262 (removed by `f3592bdb`) already solved most switch-safety problems: vault v3, idle assertion, exit-proofed stop, install/verify/rollback, identity derived from the permanent `auth.json` rather than a persisted selector, in-flight responses returned to the original request client, and bounded drain of in-flight rate-limit reads. This change re-lands that core, minus device-code login and minus external process termination, and adds the quota ranker and Auto mode.

## Goals / Non-Goals

**Goals**

- N managed Codex accounts: explicit save-current, list, switch, delete non-current.
- Credentials as opaque secrets: verbatim `auth.json` text, unknown fields preserved, 0700/0600 + atomic writes, never in Renderer/log/error/public contracts.
- Switch as a controlled transaction that can never leave "UI shows B, backend is A" silently.
- Per-account quota on `AccountCreditsSnapshot`; unknown stays unknown.
- Explainable, testable, Harness-neutral quota ranking with anti-ping-pong and quarantine.
- Auto switching only between equivalent execution profiles (same Harness/Model/effort; only the Codex account changes), only at safe Turn boundaries.

**Non-Goals**

- No Host device-code login and no login app-server; adding an account uses official Desktop login followed by explicit save.
- No per-Thread account routing, per-account backend pool, or Model proxy (Account ≠ Provider ≠ Billing Source).
- No termination of Codex processes CodexHost does not own.
- No cross-provider or quality-based ranking; the ranker answers quota/account questions only. A future ModelProfile/ModelRanker may consume the same candidate summaries but is out of scope.
- No change to other Harness native auth, `inspectAccount()` semantics, `config.toml`, session/history, MCP, or Model settings during a switch.
- No automatic replay of a partially executed Turn.

## Decisions

1. **Reuse vault v3 at `<CODEX_HOME>/.codexhost-native-accounts/vault.json`.** Same format PR #262 shipped (`{version:3, revision, accounts[{accountId, identity{issuer,subject,workspaceId}, label, email?, planType?, auth:<verbatim auth.json text>}]}`), readable from 0.8.x/0.9 leftovers, upgraded in place on first write. This gives users of the removed feature their saved accounts back with zero migration tooling. Directory 0700, file 0600, atomic temp(`wx`)+rename. Alternative — a fresh store format/path — rejected: no benefit, loses free migration.

2. **Current account is derived, never persisted.** The vault entry whose identity (JWT `sub` + workspace) matches the permanent `auth.json` is current. External login/logout/token refresh therefore cannot desynchronize a stored selector (auth drift, PR #262 commit `3292c188`). When the permanent credential matches a stored account but carries a newer generation, observers refresh the stored copy; a signed-in identity not in the vault is simply "current, unsaved".

3. **Switch transaction.** `changing` phase returns to `OfficialWorkGate`; admission during a switch fails fast as busy. Steps: assert file-based storage and no API-key env override → acquire the change lease (new admissions fail fast; an ongoing native login/logout refuses the switch as busy) → synchronously ask the Turn owner (`bindIdleProbe`) whether any official or external Turn is active and refuse as busy before anything is stopped → capture current `auth.json` (refresh stored copy) → stop owned backend, awaiting exit proof → re-capture (token rotation during stop) → atomic install of target credential → start backend → verify via `account/read` polling (~200ms, ≤10s) plus permanent-file identity comparison → publish new current. On verify/start failure: reinstall the captured credential and re-verify; the earlier design referenced cc-switch's newer-generation rule, but the current implementation captures credentials before restoration and does not implement its same-account timestamp predicate (see [Credits](../../../CREDITS.md)). If no target credential was installed, rollback preserves the credential read after backend exit. If rollback itself fails, phase becomes `unavailable` with `recovery-required`. Short in-flight requests (for example a rate-limit read) are not drained: generation retire returns them to their original request client as an explicit retired failure, and they never mutate post-switch state; UI updates are gated on the verified identity read, not on install.

4. **External Codex processes are respected, not killed.** The Rust process inventory removed by `f3592bdb` is not rebuilt. Best-effort detection (platform process listing) of another Codex process using the same `CODEX_HOME` fails the switch with an explicit `unsafe-external-process` error naming the reason; the user closes it or retries. The `exec-server` Local Work executor of the Desktop instance that started the Host is exempt: it reads the native login only at startup and then holds a fixed bearer token, so it never writes `auth.json` back. Detection failure degrades to proceeding (the verify step still catches identity divergence).

5. **Saved-account quota via the ChatGPT usage endpoint.** Non-current accounts use `GET chatgpt.com/backend-api/wham/usage` (Bearer + `ChatGPT-Account-Id`), mapping `{used_percent, limit_window_seconds, reset_at}` windows (18000→five_hour, 604800→seven_day; other durations become named product windows) into `AccountCreditsSnapshot`. Expired access tokens refresh via the official OAuth endpoint with per-account single-flight; a refresh-token failure marks the account `requires-login` (quarantined; never auto-selected; row shows the reason). Fetches are on-demand (settings open/refresh, ranker evaluation) behind the existing 15s snapshot cache plus a per-account cooldown ≥3min; failures keep the last snapshot with its `observedAt` rather than fabricating values.

6. **QuotaWindow is a ranker-internal view, not a new wire contract.** `AccountCreditsSnapshot` stays the only cross-layer quota shape. The ranker derives `QuotaWindow {scope, periodType, usedPercent, resetsAt, freshness}` per candidate internally: binding window = the generic window with the least headroom; headroom, reset deadline, and waste risk (headroom that expires at reset while an alternative account is bindable) follow. `unknown` freshness or a missing binding window disqualifies a candidate from auto selection; it never ranks as 0% used.

7. **Ranker is pure and Harness-neutral.** `rankAccountCandidates(candidates, options)` in its own module, no I/O, no Codex types beyond the candidate summary; strategies: `best` (default; avoid hitting walls while not stranding quota that resets soonest), `consume-first` (concentrate usage on the most consumed eligible account, keeping the others as reserve), `waste-first` (spend the headroom that expires soonest). Output per candidate: score, derived facts, human-readable reasons, quarantine reason if excluded. Hysteresis: switching away from current requires a configured headroom margin (default 10 points) and a per-account cooldown (default 10min) since the last auto switch; both prevent A↔B ping-pong.

8. **Auto mode switches accounts only, at Turn boundaries only.** Host-side policy (default off, persisted host-side) subscribes to active-work transitions; when no official/external work is active and the gate is `ready`, it may run the switch transaction toward the ranker's pick. It never touches Harness, Model, reasoning profile, or Provider selection, and never fires while a Turn is active. On a Turn that failed at a quota wall (official error surfaced while the binding window is exhausted), the Renderer shows an explicit **Switch & Retry** action: switch transaction first, then re-submit the original user input as a new Turn upon user confirmation — never an automatic replay.

9. **Contract growth stays browser-safe.** `codex-accounts.ts` drops `max(1)`, adds per-account `{current, saved, health, credits?}`, phase `changing`, capability flags, and manage RPCs (`codexhost/account/save-current`, `codexhost/account/switch`, `codexhost/account/delete`, auto-mode read/update). Error text is fixed-form; native SDK/process errors are never forwarded. Existing `codexhost/account/changed`, instanceId/revision versioning, and the Renderer snapshot gate are reused.

## Risks / Trade-offs

- **Shared `auth.json` with external tools.** File-level switching cannot be atomic across independent clients; verify + derived current + newer-generation rules bound the damage to an explicit failed switch, not silent divergence.
- **Undocumented usage endpoint.** The ChatGPT usage endpoint may change shape or rate-limit; parsing is tolerant (unknown windows preserved as named products), failures degrade to stale-with-timestamp, and polling is bounded.
- **No login in Host.** Saving requires logging in via official Desktop first; documented flow. Trade-off accepted to avoid owning a login surface again.
- **Text-form quota-wall detection is heuristic.** Switch & Retry gates on both a failed Turn and an exhausted binding window; when detection is uncertain the UI simply offers manual switch, not retry.

## Migration

- Management is dormant while no vault exists: Host performs no credential-storage check and writes nothing until the user saves an Account. When a vault from a removed release (v1–v3) exists, Host opens it at startup so those saved Accounts are listed again, upgrading it to v3 and clearing obsolete login/transaction relics in that directory.
- No schema change to mapping-store, thread metadata, or other Harness data.
- Renderer capabilities gate all new UI: against an older Host the settings page stays read-only exactly as today.
