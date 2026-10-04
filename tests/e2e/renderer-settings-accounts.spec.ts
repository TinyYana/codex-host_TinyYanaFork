import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

test.use({ timezoneId: "Asia/Shanghai" });
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createAccountsSettingsPage } from "./packages/renderer-extension/src/settings/accounts-page.ts";
      import { createRendererSettingsPageRegistry } from "./packages/renderer-extension/src/settings/core.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
      import { mountRendererSettingsShell } from "./packages/renderer-extension/src/settings/shell.ts";

      globalThis.setupAccounts = ({ locale = "zh-CN", theme = "dark", scenario = "normal" } = {}) => {
        document.documentElement.style.colorScheme = theme;
        const managed = scenario === "managed";
        let accounts = [
          { accountId:"native",label:"Native",email:"zhaobin_jiang@163.com",planType:"pro" },
          ...(managed ? [
            { accountId:"spare",label:"Spare",email:"spare@example.com",planType:"plus",saved:true },
            { accountId:"stale",label:"Stale",email:"stale@example.com",saved:true,requiresLogin:true },
          ] : []),
        ];
        let currentAccountId = "native";
        let revision = 1;
        let auto = { enabled:false, strategy:"best" };
        const accountSnapshot = () => ({
          version:2,currentAccountId,phase:"ready",revision,instanceId:"settings-host",
          ...(managed ? { capabilities:{manage:true,saveCurrent:true,switch:true,delete:true}, auto } : {}),
          accounts,
        });
        const snapshots = {
          native: { usedPercent:9,periodType:"seven_day",resetsAt:"2026-09-13T13:16:00Z",resetCredits:{availableCount:2,nextExpiresAt:"2026-10-04T01:54:00Z",expiresAt:["2026-10-04T01:54:00Z","2026-10-08T01:54:00Z"]} },
          spare: { usedPercent:40,periodType:"five_hour",resetsAt:"2026-09-10T11:20:00Z",productUsage:[{product:"7-day window",usagePercent:20,resetsAt:"2026-09-15T08:20:00Z"}] },
        };
        // Mutations answer only when the test releases them, so pending UI is observable.
        let releaseSwitch = () => {};
        const changed = () => { revision += 1; return accountSnapshot(); };
        let harnessAccounts = scenario === "balance" ? [
          {harnessId:"pi",harnessName:"Pi",label:"qingge",balance:{amount:4,currency:"USD",label:"钱包余额"}},
          {harnessId:"pi",harnessName:"Pi",label:"DeepSeek",balance:{amount:12.5,currency:"CNY",label:"DeepSeek API"}},
        ] : [
          {harnessId:"grok",harnessName:"Grok Build",email:"grok@example.com",credits:{usedPercent:0,periodType:"weekly",resetsAt:"2026-09-17T03:32:00Z"}},
          {harnessId:"antigravity",harnessName:"Antigravity",credits:{label:"Gemini Models · Weekly window",usedPercent:10,periodType:"weekly"}},
          {harnessId:"claude-code",harnessName:"Claude Code",email:"claude@example.com",plan:"max",credits:{usedPercent:0,periodType:"five_hour",productUsage:[{product:"7-day window",usagePercent:50}]}},
        ];
        if (scenario === "layout") harnessAccounts.push({
          harnessId:"kimi-code",harnessName:"Kimi Code",credits:{usedPercent:0,periodType:"weekly",resetsAt:"2026-09-17T03:32:00Z",productUsage:[{product:"Kimi Code · 5-hour",usagePercent:12,resetsAt:"2026-09-10T09:00:00Z"}]},
        });
        let failUsage = scenario === "error";
        const calls = { inspect:[], imports:[], manage:[] };
        const sources = [
          {id:"codex:fixture",harnessId:"codex",provider:"openai-codex",label:"zhaobin_jiang@163.com"},
          {id:"grok:fixture",harnessId:"grok",provider:"xai",label:"grok@example.com"},
        ];
        let imported = [];
        const client = {
          credentialImports: async (request) => {
            calls.imports.push(request);
            if (request.action === "import") imported.push({name:request.name,source:sources.find(s=>s.id===request.sourceId),importedAt:"2026-09-10T08:20:00Z"});
            if (request.action === "remove") imported = imported.filter(r=>r.name!==request.name);
            return {sources,targets:[{harnessId:"pi",providers:["openai-codex","xai"],imports:imported,others:[{provider:"anthropic",type:"oauth"},{provider:"codex1",type:"oauth",label:"same@example.com",vendor:"openai-codex"},{provider:"openai-codex",type:"api_key"}]}]};
          },
          ...(["external", "balance", "layout"].includes(scenario) ? {listHarnessAccounts: async () => ({accounts:harnessAccounts})} : {}),
          listCodexAccounts: async () => accountSnapshot(),
          refreshCodexAccounts: async () => accountSnapshot(),
          ...(managed ? {
            saveCurrentCodexAccount: async () => {
              calls.manage.push(["save"]);
              accounts = accounts.map(a => a.accountId === currentAccountId ? {...a,saved:true} : a);
              return changed();
            },
            switchCodexAccount: ({accountId}) => new Promise((resolve, reject) => {
              calls.manage.push(["switch",accountId]);
              releaseSwitch = (failure) => {
                if (failure) { reject(Object.assign(new Error("native detail must stay hidden"),{code:-32086,data:{code:failure}})); return; }
                currentAccountId = accountId;
                resolve(changed());
              };
            }),
            deleteCodexAccount: async ({accountId}) => {
              calls.manage.push(["delete",accountId]);
              accounts = accounts.filter(a => a.accountId !== accountId);
              return changed();
            },
            updateCodexAccountAuto: async (input) => {
              calls.manage.push(["auto",input]);
              auto = {...auto,...input};
              return changed();
            },
            inspectCodexAccountRanking: async () => ({strategy:auto.strategy,recommendedAccountId:"spare",entries:[
              {accountId:"spare",eligible:true,bindingPeriod:"five_hour",headroomPercent:60,reasons:["60% headroom on the binding five_hour window"]},
              {accountId:"stale",eligible:false,reasons:["Credential needs a native re-login"]},
            ]}),
          } : {}),
          inspectCodexAccountUsage: async ({accountId}) => {
            calls.inspect.push(accountId);
            if (failUsage) throw new Error("offline");
            return {accountId,usage:null,accountCredits:snapshots[accountId],freshness:"cached",observedAt:"2026-09-10T08:20:00.000Z"};
          },
        };
        globalThis.accountsFixture = {
          calls,
          recover: () => { failUsage=false; },
          releaseSwitch: (failure) => releaseSwitch(failure),
          clearHarnessAccounts: () => { harnessAccounts=[]; },
        };
        const messages=rendererSettingsMessages(locale);
        const registry=createRendererSettingsPageRegistry([createAccountsSettingsPage(messages,()=>client)]);
        const shell=mountRendererSettingsShell(registry,document,messages);
        shell.openSettings(undefined,"accounts");
        globalThis.accountsFixture.dispose = () => shell.dispose();
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "settings-accounts-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  plugins: [tailwindEsbuildPlugin()],
  write: false,
});
const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("Account settings fixture bundle missing");

async function setup(page: Page, options = {}) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("http://localhost/accounts-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("http://localhost/accounts-test");
  await page.clock.install({ time: new Date("2026-09-10T08:20:00Z") });
  await page.clock.pauseAt(new Date("2026-09-10T08:20:00Z"));
  await page.addScriptTag({ content: bundle });
  await page.evaluate((options) => Reflect.get(globalThis, "setupAccounts")(options), options);
}

const nativeRow = '[data-account-id="native"]';

test("shows detected Harness quota read-only and removes rows when authentication has no data", async ({
  page,
}) => {
  await setup(page, { scenario: "external" });
  const section = page.locator(".settings-account-table");
  const nativeAccounts = section.locator("tr[data-harness-id]");
  await expect(nativeAccounts).toHaveCount(3);
  await expect(page.locator(".settings-account-count")).toHaveText("账号4");
  await expect(
    nativeAccounts.getByRole("button", { name: /切换|删除|使用重置|登录$/ }),
  ).toHaveCount(0);
  await expect(
    section.locator('[data-harness-id="grok"] .settings-account-person-cell'),
  ).toHaveAttribute("title", /登录、退出和切换请在其原生客户端中完成/);
  // No per-row refresh or native-management text; only compatible logins get the Pi import chip.
  await expect(section.getByText("原生管理")).toHaveCount(0);
  await expect(section.getByRole("button", { name: "刷新额度" })).toHaveCount(0);
  await expect(section.locator('[data-harness-id="grok"] .settings-account-pi-import')).toHaveText(
    "导入到 Pi",
  );
  await expect(
    section.locator(
      '[data-harness-id="claude-code"] .settings-account-pi-import, [data-harness-id="antigravity"] .settings-account-pi-import',
    ),
  ).toHaveCount(0);
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").clearHarnessAccounts());
  await page.locator(".settings-account-toolbar").getByRole("button", { name: "刷新额度" }).click();
  await expect(nativeAccounts).toHaveCount(0);
  await expect(page.locator(".settings-account-count")).toHaveText("账号1");
});

test("shows each prepaid Billing Source without inventing quota percentages", async ({
  page,
}, testInfo) => {
  await setup(page, { scenario: "balance" });
  const piRows = page.locator('.settings-account-table tr[data-harness-id="pi"]');
  await expect(piRows).toHaveCount(2);
  await expect(piRows.filter({ hasText: "qingge" })).toContainText("USD 4.00");
  await expect(piRows.filter({ hasText: "DeepSeek" })).toContainText("CNY 12.50");
  await expect(piRows.getByRole("meter")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("accounts-balance-wide.png") });
  await page.setViewportSize({ width: 700, height: 900 });
  for (const cell of await piRows.locator(".settings-account-balance-cell").all()) {
    await expect(cell).toBeVisible();
    const box = await cell.boundingBox();
    if (!box) throw new Error("Balance cell has no visible bounds");
    expect(box.x + box.width).toBeLessThanOrEqual(700);
  }
  await page.screenshot({ path: testInfo.outputPath("accounts-balance-narrow.png") });
});

test("shows current Codex quota, reset-credit count, and no Host consume or login actions", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator(".settings-account-table th")).toHaveText(["账号", "剩余额度"]);
  await expect(page.locator(`${nativeRow} .settings-account-active`)).toHaveText("当前");
  await expect(page.locator(`${nativeRow} .settings-account-plan`)).toHaveText("Pro 20x");
  await expect(page.locator(`${nativeRow} .settings-account-reset-summary`)).toContainText("2 张");
  await expect(page.getByRole("button", { name: "添加 Codex 账号" })).toHaveCount(0);
  // Without Host capabilities the page stays read-only: no management entry of any kind.
  await expect(
    page.getByRole("button", { name: /保存目前帳號|切換到|刪除已保存|修復/ }),
  ).toHaveCount(0);
  await expect(page.locator("[data-codex-account-auto]")).toBeHidden();
  await expect(page.getByText("新增其他帳號")).toBeHidden();
  await expect(page.getByRole("button", { name: "登录", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "使用重置", exact: true })).toHaveCount(0);
  await page.locator(`${nativeRow} .settings-account-reset-summary`).click();
  await expect(page.locator(".settings-account-details-row:not([hidden]) li")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "使用重置", exact: true })).toHaveCount(0);
});

test("imports from a row chip or the Pi section without adding a table column", async ({
  page,
}) => {
  await setup(page, { scenario: "external" });
  await page.setViewportSize({ width: 700, height: 900 });
  const chip = page.locator(`${nativeRow} .settings-account-pi-import`);
  await expect(chip).toHaveText("导入到 Pi");
  // The chip shares the identity's extras line with the reset cards instead of a third column.
  await expect(
    page.locator(`${nativeRow} .settings-account-row__extras .settings-account-reset-summary`),
  ).toHaveCount(1);
  await expect(page.locator(".settings-account-table th")).toHaveText(["账号", "剩余额度"]);
  const pi = page.getByRole("region", { name: "Pi 中的账号" });
  await expect(pi.locator(".settings-pi-accounts__hint")).toBeVisible();
  // Logins Pi already had sit behind a disclosure that starts collapsed.
  const group = pi.locator(".settings-pi-accounts__others");
  const toggle = pi.getByRole("button", { name: /Pi 自有配置/ });
  await expect(group).toBeHidden();
  await toggle.click();
  await expect(group.locator(".settings-pi-accounts__row--other")).toHaveCount(3);
  await expect(group.getByRole("button")).toHaveCount(0);

  await chip.click();
  const dialog = page.getByRole("dialog", { name: "导入到 Pi", exact: true });
  await expect(dialog).toContainText("保留全部已有 Provider 配置");
  await expect(dialog.getByLabel("模型入口名称")).toHaveValue("codex");
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await dialog.getByRole("button", { name: "确认导入", exact: true }).click();
  const done = page.getByRole("dialog", { name: "已复制到 Pi", exact: true });
  await expect(done).toContainText("复制不代表已验证模型调用");
  await done.getByRole("button", { name: "完成", exact: true }).click();
  await expect(chip).toHaveAttribute("data-state", "imported");
  await expect(chip).toContainText("codex/…");
  await expect(pi).toContainText("zhaobin_jiang@163.com");

  // The section's own entry lets the user choose among compatible logins.
  await pi.getByRole("button", { name: "导入账号", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "导入到 Pi", exact: true });
  await expect(picker.getByRole("radio")).toHaveCount(2);
  await expect(picker.getByRole("radio", { name: /grok@example.com/ })).toBeChecked();
  await expect(picker.getByLabel("模型入口名称")).toHaveValue("grok");
  await expect(picker).toContainText("已导入为 codex/…");
  await picker.getByRole("button", { name: "确认导入", exact: true }).click();
  await page
    .getByRole("dialog", { name: "已复制到 Pi", exact: true })
    .getByRole("button", { name: "完成", exact: true })
    .click();
  await expect(page.locator('[data-harness-id="grok"] .settings-account-pi-import')).toContainText(
    "grok/…",
  );

  await pi.getByRole("button", { name: /重新导入凭证: zhaobin/ }).click();
  const reimport = page.getByRole("dialog", { name: "重新导入凭证", exact: true });
  await expect(reimport).toContainText("使用同一来源账号更新 codex/…");
  await reimport.getByRole("button", { name: "取消", exact: true }).click();

  await pi.getByRole("button", { name: /从 Pi 移除: zhaobin/ }).click();
  const removal = page.getByRole("dialog", { name: "从 Pi 移除", exact: true });
  await removal.getByRole("button", { name: "从 Pi 移除", exact: true }).click();
  await expect(page.locator(".settings-credential-dialog[open]")).toHaveCount(0);
  await expect(chip).not.toHaveAttribute("data-state", /.+/);
  await expect(chip).toHaveText("导入到 Pi");

  // Collapsing the section hides its list but keeps the header and import entry.
  await pi.getByRole("button", { name: /Pi 中的账号/ }).click();
  await expect(pi.locator(".settings-pi-accounts__card")).toBeHidden();
  await expect(pi.getByRole("button", { name: "导入账号", exact: true })).toBeVisible();
});

test("shows emails by default and masks their middle on demand across the page", async ({
  page,
}, testInfo) => {
  await setup(page, { scenario: "external" });
  const toolbar = page.locator(".settings-account-toolbar");
  const toggle = toolbar.getByRole("button", { name: "隐藏邮箱", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const nativeEmail = page.locator(`${nativeRow} .settings-account-email`);
  const grokEmail = page.locator('[data-harness-id="grok"] .settings-account-email');
  await expect(nativeEmail).toHaveText("zhaobin_jiang@163.com");
  // Import once so the Pi section also lists an email.
  await page.locator(`${nativeRow} .settings-account-pi-import`).click();
  await page
    .getByRole("dialog", { name: "导入到 Pi", exact: true })
    .getByRole("button", { name: "确认导入", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "已复制到 Pi", exact: true })
    .getByRole("button", { name: "完成", exact: true })
    .click();
  const pi = page.getByRole("region", { name: "Pi 中的账号" });

  await toggle.click();
  const reveal = toolbar.getByRole("button", { name: "显示邮箱", exact: true });
  await expect(reveal).toHaveAttribute("aria-pressed", "true");
  await expect(nativeEmail).toHaveText("zh****ng@163.com");
  await expect(nativeEmail).toHaveAttribute("title", "zh****ng@163.com");
  await expect(grokEmail).toHaveText("g****k@example.com");
  await expect(page.getByText("zhaobin_jiang", { exact: false })).toHaveCount(0);
  await expect(pi).toContainText("zh****ng@163.com");
  await page.screenshot({ path: testInfo.outputPath("accounts-emails-hidden.png") });
  // Masking is display-only: search still finds the account by its real email.
  await toolbar.getByRole("searchbox").fill("zhaobin");
  await expect(nativeEmail).toHaveText("zh****ng@163.com");
  await toolbar.getByRole("searchbox").fill("");

  await reveal.click();
  await expect(nativeEmail).toHaveText("zhaobin_jiang@163.com");
  await expect(pi).toContainText("zhaobin_jiang@163.com");
});

test("keeps quota columns aligned with the Pi chip in the identity and spans single limits", async ({
  page,
}, testInfo) => {
  await setup(page, { scenario: "layout", theme: "light" });
  const kimi = page.locator('.settings-account-table tr[data-harness-id="kimi-code"]');
  await expect(kimi).toHaveCount(1);
  await expect(kimi.getByRole("meter")).toHaveCount(2);
  await expect(kimi.locator(".settings-account-usage-cell")).toHaveCount(2);
  await expect(
    page.locator(
      '[data-harness-id="grok"] .settings-account-person-cell .settings-account-pi-import',
    ),
  ).toHaveCount(1);
  await expect(page.locator(".settings-account-table col")).toHaveCount(3);
  for (const header of await page.locator(".settings-account-table th").all()) {
    await expect(header).toHaveCSS("text-align", "center");
  }
  const single = page.locator('[data-harness-id="grok"] .settings-account-usage-cell');
  await expect(single).toHaveCount(1);
  await expect(single).toHaveAttribute("colspan", "2");
  const dual = page.locator('[data-harness-id="claude-code"] .settings-account-usage-cell');
  await expect(dual).toHaveCount(2);
  const left = await dual.nth(0).boundingBox();
  const right = await dual.nth(1).boundingBox();
  const wide = await single.boundingBox();
  if (!left || !right || !wide) throw new Error("Missing quota bounds");
  expect(left.y).toBe(right.y);
  expect(Math.abs(wide.width - left.width - right.width)).toBeLessThan(2);
  await page.screenshot({ path: testInfo.outputPath("accounts-wide.png") });
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(single).toBeVisible();
  const narrow = await single.boundingBox();
  if (!narrow) throw new Error("Missing narrow quota bounds");
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(700);
  await page.screenshot({ path: testInfo.outputPath("accounts-narrow.png") });
  // Rendering the page only lists imports; nothing is copied without confirmation.
  expect(
    (await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").calls.imports)).every(
      (request: { action: string }) => request.action === "list",
    ),
  ).toBe(true);
});

test("updates compact countdowns without requests or inventing a reset", async ({ page }) => {
  await setup(page);
  const countdown = page.locator(`${nativeRow} [data-resets-at]`).first();
  await expect(countdown).toHaveText("3d4h");
  const inspect = await page.evaluate(
    () => Reflect.get(globalThis, "accountsFixture").calls.inspect,
  );
  await page.clock.runFor(60_000);
  await expect(countdown).toHaveText("3d4h");
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").calls.inspect),
  ).toEqual(inspect);
});

test("saves, switches and removes managed Codex accounts only from the Host's answers", async ({
  page,
}) => {
  await setup(page, { scenario: "managed" });
  const row = (accountId: string) =>
    page.locator(`tr.settings-account-row[data-account-id="${accountId}"]`).first();
  const manageCalls = () =>
    page.evaluate(() => Reflect.get(globalThis, "accountsFixture").calls.manage);

  // Every Codex Account shows its own quota; one that needs a re-login stays unknown.
  await expect(row("spare").locator("[data-resets-at]").first()).toBeVisible();
  await expect(row("stale")).toContainText("需重新登入");
  await expect(row("stale").locator(".settings-account-usage__message")).toHaveText("—");
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").calls.inspect),
  ).toEqual(expect.arrayContaining(["native", "spare"]));
  await expect(page.getByRole("button", { name: "切換到 stale@example.com" })).toBeDisabled();
  await expect(page.getByText("新增其他帳號")).toBeVisible();
  await expect(row("spare")).toContainText("建議");

  // Save the current native login.
  await expect(row("native")).toContainText("尚未保存");
  await page.getByRole("button", { name: "保存目前帳號" }).click();
  await expect(page.getByRole("button", { name: "保存目前帳號" })).toBeHidden();
  await expect(row("native")).not.toContainText("尚未保存");

  // A refused switch explains itself with fixed text and changes nothing.
  await page.getByRole("button", { name: "切換到 spare@example.com" }).click();
  await expect(page.locator(".settings-account-status").nth(1)).toContainText("正在切換帳號…");
  await expect(row("native").locator(".settings-account-active")).toHaveText("当前");
  await expect(row("spare").locator(".settings-account-active")).toHaveCount(0);
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").releaseSwitch("busy"));
  await expect(page.locator(".settings-account-status").nth(1)).toContainText("有 Turn 正在進行");
  await expect(page.locator("body")).not.toContainText("native detail must stay hidden");
  await expect(row("native").locator(".settings-account-active")).toHaveText("当前");

  // A verified switch moves the current mark, and only then.
  await page.getByRole("button", { name: "切換到 spare@example.com" }).click();
  await expect(page.getByRole("button", { name: /刪除已保存的帳號/ }).first()).toBeDisabled();
  await expect(row("spare").locator(".settings-account-active")).toHaveCount(0);
  await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").releaseSwitch());
  await expect(row("spare").locator(".settings-account-active")).toHaveText("当前");
  await expect(row("native").locator(".settings-account-active")).toHaveCount(0);
  await expect(page.locator(".settings-account-status").nth(1)).toContainText(
    "已切換到 spare@example.com。",
  );

  // Removing a saved, non-current Account needs confirmation.
  await expect(
    page.getByRole("button", { name: "刪除已保存的帳號 spare@example.com" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "刪除已保存的帳號 zhaobin_jiang@163.com" }).click();
  const dialog = page.getByRole("dialog", { name: "刪除已保存的帳號 zhaobin_jiang@163.com" });
  await expect(dialog).toContainText("原生登入不受影響");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(row("native")).toHaveCount(1);
  await page.getByRole("button", { name: "刪除已保存的帳號 zhaobin_jiang@163.com" }).click();
  await dialog.getByRole("button", { name: "刪除", exact: true }).click();
  await expect(row("native")).toHaveCount(0);
  expect(await manageCalls()).toEqual([
    ["save"],
    ["switch", "spare"],
    ["switch", "spare"],
    ["delete", "native"],
  ]);
});

test("controls Auto account selection and fits a narrow window", async ({ page }) => {
  await setup(page, { scenario: "managed" });
  await page.setViewportSize({ width: 700, height: 900 });
  const auto = page.locator("[data-codex-account-auto]");
  await expect(auto).toContainText("在 Turn 之間，自動換到額度最合適的已保存帳號。");
  const toggle = auto.getByRole("switch", { name: "自動切換" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await auto.getByRole("combobox", { name: "策略" }).selectOption("waste-first");
  await expect(auto).toContainText("優先使用下次重置時會過期的額度。");
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "accountsFixture").calls.manage),
  ).toEqual([
    ["auto", { enabled: true }],
    ["auto", { strategy: "waste-first" }],
  ]);
  // Row actions stay inside the page at the narrow breakpoint.
  const overflow = await page.evaluate(() => {
    const host = document.querySelector("[data-codexhost-settings-shell]");
    const root = host?.shadowRoot ?? document;
    const button = [...root.querySelectorAll("button")].find((candidate) =>
      candidate.getAttribute("aria-label")?.startsWith("切換到 spare"),
    );
    const content = button?.closest(".settings-account-list");
    if (!button || !content) return null;
    return button.getBoundingClientRect().right <= content.getBoundingClientRect().right + 1;
  });
  expect(overflow).toBe(true);
});
