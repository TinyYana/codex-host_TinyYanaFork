## ADDED Requirements

### Requirement: Host SHALL manage saved Codex accounts as opaque secrets

CodexHost SHALL keep saved Codex accounts in a vault under `<CODEX_HOME>/.codexhost-native-accounts/` with directory mode 0700, file mode 0600, and atomic replace writes. Each saved credential SHALL be the verbatim native `auth.json` text with unknown fields preserved. Credential material SHALL NOT appear in Renderer-visible contracts, logs, diagnostics, or error text. The vault SHALL support at least two accounts and impose no fixed upper count. Existing v1–v3 vault files from removed releases SHALL be readable and upgraded to v3 when opened. While no vault exists Host SHALL NOT create one, check credential storage, or write anything until the user saves an Account.

#### Scenario: Save current account

- **WHEN** the user is signed in via official Desktop with a file-based ChatGPT credential and invokes save-current
- **THEN** Host SHALL store the verbatim credential in the vault keyed by its native identity
- **AND** saving the same identity again SHALL update that entry in place

#### Scenario: Credential never crosses the browser contract

- **WHEN** any `codexhost/account/*` request or notification is produced
- **THEN** its payload SHALL contain only display identity, plan, quota, health, and capability data
- **AND** SHALL NOT contain tokens, credential file text, or native file paths

#### Scenario: Unsupported storage is refused

- **WHEN** the current login uses an API key, an `OPENAI_API_KEY` override, or keyring-backed storage
- **THEN** save-current and switch SHALL fail with a fixed-form unsupported-storage error and change nothing

### Requirement: Current account SHALL be derived from native credentials

The current account SHALL be derived by matching the permanent `auth.json` identity against vault entries, never from a persisted selector. After external login, logout, or token refresh, the derived current SHALL follow the native file. When the permanent credential is a newer generation of a saved account, Host MAY refresh the stored copy; Host SHALL NOT overwrite a newer stored generation with an older one.

#### Scenario: External re-login changes current

- **WHEN** the user logs into a different account via official Desktop while two accounts are saved
- **THEN** the account list SHALL report the newly signed-in identity as current without a Host switch

### Requirement: Account switch SHALL be a verified transaction

Switching SHALL: assert idle (no active official or external work; new admissions fail fast as busy during the switch), capture the current credential, stop the owned backend awaiting exit proof, atomically install the target credential, start the backend, and verify identity via official `account/read` before updating current state or UI. In-flight official requests SHALL be returned to their original request client as an explicit retired failure rather than silently dropped. On start or verify failure, Host SHALL reinstall the captured credential and re-verify; if rollback fails the account phase SHALL become `unavailable` requiring recovery. Responses and notifications from a retired backend generation SHALL NOT update post-switch state or UI.

#### Scenario: Successful switch

- **WHEN** the user switches to a saved, healthy account while idle
- **THEN** current/UI SHALL update only after the new backend's `account/read` returns the target identity

#### Scenario: Verify failure rolls back

- **WHEN** the installed target credential fails identity verification within the bounded window
- **THEN** Host SHALL reinstall the captured credential, restart, and report a fixed-form switch failure
- **AND** the displayed current account SHALL match the verified backend identity

#### Scenario: Busy work refuses the switch

- **WHEN** a Turn or other admitted official work is active
- **THEN** the switch SHALL fail fast with a busy error and SHALL NOT stop the backend or queue the switch

#### Scenario: Late responses cannot corrupt state

- **WHEN** a response from the pre-switch backend generation arrives after the switch completes
- **THEN** it SHALL be delivered to its original request client as a retired-generation failure or result
- **AND** SHALL NOT change the displayed identity, quota attribution, or vault contents

### Requirement: Host SHALL NOT terminate external Codex processes for a switch

CodexHost SHALL only stop the backend it owns. When another Codex process appears to use the same `CODEX_HOME`, the switch SHALL fail with an explicit unsafe-external-process error instead of terminating it. The `exec-server` Local Work executor started by the same Desktop instance as the Host is not external. Detection is best-effort; when detection is unavailable the transaction relies on identity verification.

#### Scenario: External CLI blocks the switch

- **WHEN** a user-launched Codex CLI on the same home is detected during a switch
- **THEN** the switch SHALL fail with the unsafe-external-process reason and terminate nothing

#### Scenario: Desktop Local Work executor does not block the switch

- **WHEN** the only other Codex process on the same home is the `exec-server` that the Desktop instance running this Host started
- **THEN** detection SHALL NOT treat it as external and the switch SHALL proceed

### Requirement: Delete SHALL affect only saved non-current entries

Deleting SHALL remove a non-current vault entry only. Host SHALL NOT delete the current account, touch the permanent `auth.json`, or log the user out. Official Desktop `account/login/*` and `account/logout` SHALL remain forwarded to the official backend unchanged; native logout SHALL NOT delete saved entries.

#### Scenario: Delete non-current account

- **WHEN** the user deletes a saved account that is not current
- **THEN** only that vault entry is removed and the native login is untouched

### Requirement: Switch SHALL NOT move non-credential state

A switch SHALL replace only the credential file. `config.toml`, session/history data, MCP configuration, and Model settings SHALL NOT be copied, swapped, or rewritten per account.

#### Scenario: Shared configuration survives a switch

- **WHEN** the user switches accounts
- **THEN** `config.toml` and session history bytes are unchanged by the transaction
