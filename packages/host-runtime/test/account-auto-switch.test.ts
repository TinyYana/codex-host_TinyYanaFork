import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AccountCreditsSnapshot,
  CodexAccountListResult,
  CodexAccountUsageResult,
} from "@codexhost/shared-contracts";
import { CodexAccountAutoSwitch } from "../src/account/account-auto-switch.js";
import type { CodexAccountControl } from "../src/account/codex-account-control.js";
import {
  codexHomeFromEnvironmentListing,
  findExternalCodexProcesses,
  isExecServerInvocation,
  isUnderHostDesktop,
  parseProcessRows,
  selectExternalCodexPids,
} from "../src/account/external-codex-processes.js";

const NOW = Date.parse("2026-09-21T12:00:00Z");
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function usage(accountId: string, used: number | null): CodexAccountUsageResult | null {
  if (used === null) return null;
  const accountCredits: AccountCreditsSnapshot = {
    usedPercent: used,
    periodType: "five_hour",
    resetsAt: new Date(NOW + 3_600_000).toISOString(),
  };
  return {
    accountId,
    usage: null,
    accountCredits,
    freshness: "live",
    observedAt: new Date(NOW - 1_000).toISOString(),
  };
}

async function setup(input: { a: number | null; b: number | null; bRequiresLogin?: boolean }) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-auto-switch-"));
  directories.push(directory);
  let current = "a";
  let idle = true;
  const switched = vi.fn(async (accountId: string) => {
    current = accountId;
  });
  const control: CodexAccountControl = {
    snapshot: (): CodexAccountListResult => ({
      version: 2,
      currentAccountId: current,
      phase: "ready",
      revision: 0,
      capabilities: { manage: true, saveCurrent: true, switch: true, delete: true },
      accounts: [
        { accountId: "a", label: "A", saved: true },
        {
          accountId: "b",
          label: "B",
          saved: true,
          ...(input.bRequiresLogin ? { requiresLogin: true } : {}),
        },
      ],
    }),
    currentAccountId: () => current,
    switch: switched,
    inspectInactiveUsage: async (accountId) => {
      const result = usage(accountId, accountId === "a" ? input.a : input.b);
      if (!result) throw new Error("unavailable");
      return result;
    },
  };
  let now = NOW;
  const auto = new CodexAccountAutoSwitch({
    directory,
    control,
    currentUsage: async (accountId) => usage(accountId, accountId === "a" ? input.a : input.b),
    isIdle: () => idle,
    diagnosticOutput: { write: () => true },
    now: () => now,
  });
  return {
    auto,
    switched,
    directory,
    setIdle: (value: boolean) => (idle = value),
    advance: (ms: number) => (now += ms),
  };
}

describe("CodexAccountAutoSwitch", () => {
  it("is Manual by default and never switches", async () => {
    const { auto, switched } = await setup({ a: 99, b: 0 });
    await auto.evaluate();
    expect(auto.mode()).toEqual({ enabled: false, strategy: "best" });
    expect(switched).not.toHaveBeenCalled();
  });

  it("switches at an idle boundary to the ranked Account and persists the mode", async () => {
    const { auto, switched, directory } = await setup({ a: 99, b: 10 });
    await auto.update({ enabled: true });
    await auto.evaluate();
    expect(switched).toHaveBeenCalledExactlyOnceWith("b");
    const reloaded = new CodexAccountAutoSwitch({
      directory,
      control: { snapshot: vi.fn(), currentAccountId: () => null } as never,
      currentUsage: async () => null,
      isIdle: () => true,
      diagnosticOutput: { write: () => true },
    });
    await reloaded.load();
    expect(reloaded.mode()).toEqual({ enabled: true, strategy: "best" });
  });

  it("never switches while a Turn is active", async () => {
    const { auto, switched, setIdle } = await setup({ a: 99, b: 10 });
    await auto.update({ enabled: true });
    setIdle(false);
    await auto.evaluate();
    expect(switched).not.toHaveBeenCalled();
  });

  it("never selects an unknown-quota or unusable-credential Account", async () => {
    const unknown = await setup({ a: 99, b: null });
    await unknown.auto.update({ enabled: true });
    await unknown.auto.evaluate();
    expect(unknown.switched).not.toHaveBeenCalled();

    const unusable = await setup({ a: 99, b: 0, bRequiresLogin: true });
    await unusable.auto.update({ enabled: true });
    await unusable.auto.evaluate();
    expect(unusable.switched).not.toHaveBeenCalled();
    const ranking = await unusable.auto.ranking();
    expect(ranking.entries.find((entry) => entry.accountId === "b")).toMatchObject({
      eligible: false,
    });
  });

  it("does not ping-pong: a fresh switch starts the cooldown", async () => {
    const { auto, switched, advance } = await setup({ a: 60, b: 10 });
    await auto.update({ enabled: true });
    await auto.evaluate();
    expect(switched).toHaveBeenCalledTimes(1);
    advance(2 * 60_000);
    await auto.evaluate();
    expect(switched).toHaveBeenCalledTimes(1);
  });

  it("keeps the verified current Account when the switch is refused", async () => {
    const { auto, switched } = await setup({ a: 99, b: 10 });
    switched.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "busy" }));
    await auto.update({ enabled: true });
    await expect(auto.evaluate()).resolves.toBeUndefined();
  });
});

describe("external Codex process detection", () => {
  const rows = parseProcessRows(
    [
      "  100     1 /Applications/Codex.app/Contents/MacOS/Codex",
      "  200   100 /usr/local/bin/node",
      "  300   200 /Applications/Codex.app/Contents/Resources/codex",
      "  400     1 /opt/homebrew/bin/codex",
      "  500   400 /bin/zsh",
    ].join("\n"),
  );

  it("ignores the Desktop shell and the Host's own backend, reports an external CLI", () => {
    expect(selectExternalCodexPids(rows, { executableNames: ["codex"], hostPid: 200 })).toEqual([
      400,
    ]);
  });

  describe("Desktop Local Work executor", () => {
    const codex = "/Applications/Codex.app/Contents/Resources/codex";
    const shim = "/Applications/Codex.app/Contents/Resources/libexec/codexhost-shim";
    const tree = [
      `  100     1 /Applications/Codex.app/Contents/MacOS/Codex`,
      `  110   100 ${shim}`,
      `  120   110 /usr/local/bin/node`,
      `  130   120 ${codex}`,
      `  140   100 ${shim}`,
      `  150   140 ${codex}`,
      `  160   100 ${shim}`,
      `  170   160 ${codex}`,
      `  200     1 /Applications/Codex.app/Contents/MacOS/Codex`,
      `  210   200 ${shim}`,
      `  220   210 ${codex}`,
      `  300     1 /bin/zsh`,
      `  310   300 /opt/homebrew/bin/codex`,
    ].join("\n");
    const executor = `${codex} -c forced_login_method="chatgpt" exec-server --remote https://example.invalid/api --environment-id env`;
    const helper = `${codex} -c forced_login_method="chatgpt" app-server`;
    const invocations: Record<number, string> = {
      130: `${codex} app-server --listen ws://127.0.0.1:0`,
      150: executor,
      170: helper,
      220: executor,
      310: `/opt/homebrew/bin/codex exec-server --remote https://example.invalid/api --environment-id env`,
    };
    const ps = async (args: readonly string[]): Promise<string> => {
      if (args[0] === "-axo") return tree;
      const pid = Number(args.at(-1));
      // `ps eww` without a visible CODEX_HOME: every candidate counts as using the default home.
      return args[0] === "-ww"
        ? `${invocations[pid] ?? ""}\n`
        : `${invocations[pid] ?? ""} PATH=/bin\n`;
    };

    it.skipIf(process.platform === "win32")(
      "allows only the exec-server started by this Host's Desktop through its Shim",
      async () => {
        await expect(
          findExternalCodexProcesses({
            home: "/home/u/.codex",
            defaultHome: "/home/u/.codex",
            executableNames: ["codex"],
            hostPid: 120,
            ps,
          }),
        ).resolves.toEqual([170, 220, 310]);
      },
    );

    it("recognizes the exec-server subcommand only in subcommand position", () => {
      expect(isExecServerInvocation(executor, codex)).toBe(true);
      expect(isExecServerInvocation(`${codex} exec-server --remote u`, codex)).toBe(true);
      expect(isExecServerInvocation(helper, codex)).toBe(false);
      expect(isExecServerInvocation(`${codex} exec "run exec-server"`, codex)).toBe(false);
      expect(isExecServerInvocation(`${codex} --profile p exec-server`, codex)).toBe(false);
      expect(isExecServerInvocation("", codex)).toBe(false);
    });

    it("finds no Desktop for a Host that a Shim did not start", () => {
      const rows = parseProcessRows(tree);
      expect(isUnderHostDesktop(rows, 150, 130)).toBe(false);
      expect(isUnderHostDesktop(rows, 150, 120)).toBe(true);
      expect(isUnderHostDesktop(rows, 220, 120)).toBe(false);
    });
  });

  it("reads CODEX_HOME from an environment listing when visible", () => {
    expect(codexHomeFromEnvironmentListing("codex exec PATH=/bin CODEX_HOME=/tmp/other X=1")).toBe(
      "/tmp/other",
    );
    expect(codexHomeFromEnvironmentListing("codex exec PATH=/bin")).toBeUndefined();
  });
});
