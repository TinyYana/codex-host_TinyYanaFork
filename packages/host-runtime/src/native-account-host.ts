import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import {
  currentCodexAccountFromOfficialRead,
  type CodexAccountControl,
} from "./account/codex-account-control.js";
import { findExternalCodexProcesses } from "./account/external-codex-processes.js";
import { NativeAccountStore } from "./account/native-account-store.js";
import { NativeCodexAccounts } from "./account/native-codex-accounts.js";
import { OfficialAccountRuntime } from "./account/official-account-runtime.js";
import { officialEnvironment } from "./app-server-host.js";
import { OfficialRuntimeScope } from "./codex-runtime/official-runtime-scope.js";
import { createOwnedLoopbackBackend } from "./codex-runtime/owned-official-backends.js";

export interface PreparedLocalCodex {
  officialRuntimeScope: OfficialRuntimeScope;
  accountControl: CodexAccountControl;
  close(): Promise<void>;
}

async function canonicalCodexHome(home: string): Promise<string> {
  const absolute = path.resolve(home);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await canonicalCodexHome(parent), path.basename(absolute));
  }
}

export async function prepareLocalCodex(input: {
  stockCodexPath: string;
  arguments: string[];
  environment: NodeJS.ProcessEnv;
  diagnosticOutput: Writable;
}): Promise<PreparedLocalCodex> {
  const home = await canonicalCodexHome(
    input.environment.CODEX_HOME ?? path.join(homedir(), ".codex"),
  );
  await mkdir(home, { recursive: true });
  const scope = new OfficialRuntimeScope({
    permanentHome: home,
    diagnosticOutput: input.diagnosticOutput,
    // Local Desktop connections outlive a failed official backend generation.
    recovery: {},
    createBackend: () =>
      createOwnedLoopbackBackend({
        stockCodexPath: input.stockCodexPath,
        cwd: home,
        arguments: input.arguments,
        environment: { ...officialEnvironment(input.environment), CODEX_HOME: home },
      }),
  });
  // controlRequest requires an initialized client on this same owned backend.
  // This connection only reads native identity; it does not own authentication.
  const identityReader = scope.owner.attachManagement(async () => {});
  const identityReaderInitialization = {
    clientInfo: { name: "codexhost_identity_reader", version: "1" },
    capabilities: { experimentalApi: true },
  };
  identityReader.configure(identityReaderInitialization);
  try {
    await scope.start();
  } catch (error) {
    await scope.close();
    identityReader.close();
    throw error;
  }
  const store = new NativeAccountStore({ home });
  const runtime = new OfficialAccountRuntime({
    owner: scope.owner,
    control: { session: identityReader, initialization: identityReaderInitialization },
    environment: input.environment,
    readCredentials: () => store.readCredentials(),
    findExternalProcesses: async () =>
      findExternalCodexProcesses({
        home,
        defaultHome: await canonicalCodexHome(path.join(homedir(), ".codex")),
        executableNames: [path.basename(input.stockCodexPath), "codex"],
      }),
  });
  // Management stays dormant until a vault exists or the user saves an Account; until then this
  // only projects the official identity, exactly like a read-only deployment.
  const accounts = new NativeCodexAccounts({
    store,
    runtime,
    diagnosticOutput: input.diagnosticOutput,
    readOfficialIdentity: async () => {
      const response = await scope.owner.controlRequest("account/read", { refreshToken: false });
      if (response.error) throw new Error("Official Account read failed");
      return currentCodexAccountFromOfficialRead(response.result);
    },
  });
  void accounts.refresh().catch(() => {
    input.diagnosticOutput.write("codexhost: Codex Account identity could not be read\n");
  });
  return {
    officialRuntimeScope: scope,
    accountControl: accounts,
    close: async () => {
      try {
        await accounts.close();
      } finally {
        await scope.close();
        identityReader.close();
      }
    },
  };
}
