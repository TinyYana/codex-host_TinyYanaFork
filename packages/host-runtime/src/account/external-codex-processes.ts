import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export function parseProcessRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    const command = match?.[3];
    if (match && command) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command });
  }
  return rows;
}

function hasAncestor(rows: readonly ProcessRow[], pid: number, ancestor: number): boolean {
  const parents = new Map(rows.map((row) => [row.pid, row.ppid]));
  for (let current = pid, hops = 0; current > 1 && hops < 64; hops++) {
    if (current === ancestor) return true;
    current = parents.get(current) ?? 0;
  }
  return false;
}

/** Codex executables outside the Host's own process tree. Names match case-sensitively so the
 * Desktop shell (`Codex`) is never mistaken for the CLI (`codex`). */
export function selectExternalCodexPids(
  rows: readonly ProcessRow[],
  input: { executableNames: readonly string[]; hostPid: number },
): number[] {
  const names = new Set(input.executableNames);
  return rows
    .filter(
      (row) => names.has(path.basename(row.command)) && !hasAncestor(rows, row.pid, input.hostPid),
    )
    .map((row) => row.pid);
}

/** The Desktop instance whose Shim started this Host: the Shim's parent, the same process the Shim
 * records as its Desktop in the local runtime lease. Undefined when the Host was not started by a
 * Shim. */
export function hostDesktopPid(rows: readonly ProcessRow[], hostPid: number): number | undefined {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const shim = byPid.get(byPid.get(hostPid)?.ppid ?? 0);
  if (!shim || path.basename(shim.command) !== "codexhost-shim" || shim.ppid <= 1) return undefined;
  return shim.ppid;
}

/** Whether `pid` runs inside the Desktop instance that started this Host. */
export function isUnderHostDesktop(
  rows: readonly ProcessRow[],
  pid: number,
  hostPid: number,
): boolean {
  const desktopPid = hostDesktopPid(rows, hostPid);
  return desktopPid !== undefined && hasAncestor(rows, pid, desktopPid);
}

/**
 * Whether a `ps` argument listing is `codex [-c key=value]... exec-server ...`, the form Desktop
 * uses for its Local Work executor. Any other shape, including config values containing spaces,
 * is not recognized and stays blocked.
 */
export function isExecServerInvocation(listing: string, executable: string): boolean {
  const rest = listing.startsWith(executable)
    ? listing.slice(executable.length)
    : listing.trim().replace(/^\S+/u, "");
  const tokens = rest.trim().split(/\s+/u);
  let index = 0;
  while (tokens[index] === "-c" || tokens[index] === "--config") index += 2;
  return tokens[index] === "exec-server";
}

type ProcessListing = (args: readonly string[]) => Promise<string>;

const listProcesses: ProcessListing = async (args) =>
  (await run("ps", [...args], { timeout: 3_000, maxBuffer: 4 * 1024 * 1024 })).stdout;

/** `CODEX_HOME` from a `ps eww` line; undefined when the environment is not visible. */
export function codexHomeFromEnvironmentListing(listing: string): string | undefined {
  return /(?:^|\s)CODEX_HOME=(\S+)/u.exec(listing)?.[1];
}

/**
 * Best-effort PIDs of Codex processes this Host does not own that share `home`.
 * Never terminates anything. Any detection failure yields [] and the switch relies on
 * post-install identity verification instead.
 *
 * The Local Work executor (`codex exec-server`) of the Desktop instance that started this Host is
 * not external: it reads the native login only while starting and then keeps a fixed bearer token,
 * so it never writes `auth.json` back after a switch.
 */
export async function findExternalCodexProcesses(input: {
  home: string;
  defaultHome: string;
  executableNames: readonly string[];
  hostPid?: number;
  ps?: ProcessListing;
}): Promise<number[]> {
  // ponytail: no process listing on Windows; add a tasklist/WMI reader if switching there needs it.
  if (process.platform === "win32") return [];
  const ps = input.ps ?? listProcesses;
  const read = (args: readonly string[]) => ps(args).catch(() => "");
  try {
    const rows = parseProcessRows(await ps(["-axo", "pid=,ppid=,comm="]));
    const hostPid = input.hostPid ?? process.pid;
    const candidates = selectExternalCodexPids(rows, {
      executableNames: input.executableNames,
      hostPid,
    });
    const sharing: number[] = [];
    for (const pid of candidates) {
      if (isUnderHostDesktop(rows, pid, hostPid)) {
        const executable = rows.find((row) => row.pid === pid)?.command ?? "";
        const invocation = await read(["-ww", "-o", "args=", "-p", String(pid)]);
        if (isExecServerInvocation(invocation.trim(), executable)) continue;
      }
      const listing = await read(["eww", "-o", "command=", "-p", String(pid)]);
      const home = codexHomeFromEnvironmentListing(listing);
      if (home === undefined ? input.home === input.defaultHome : path.resolve(home) === input.home)
        sharing.push(pid);
    }
    return sharing;
  } catch {
    return [];
  }
}
