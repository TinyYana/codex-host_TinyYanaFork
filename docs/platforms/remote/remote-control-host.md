# Remote Harnesses over Remote Control (Experimental)

Use Harnesses that are installed and signed in only on a Windows machine from another computer, through Codex Desktop's official Remote Control. No SSH, no new network ports — Harness credentials and project files never leave the Windows machine.

## Prerequisites

- The machine you connect to runs Windows. So far, only macOS has been verified as the controlling side.
- On a non-Windows controlled machine, native Codex tasks still work over Remote Control, but Harnesses are unavailable; Harness requests to that Host fail with an error naming it as a non-Windows controlled machine. Use [SSH](remote-ssh-host.md) to reach Harnesses on a Mac or Linux computer.
- Both computers run the same codexhost version and launch Codex Desktop through codexhost.
- Both are signed in with the ChatGPT account Remote Control requires, and official pairing is done.
- The Harness you want to use is installed and signed in on the Windows machine.

## Connect

1. On Windows, open **Settings → Connections → Control this computer**, enable access, and generate a pairing code.
2. On the other computer, open **Settings → Connections → Control other devices**, enter the pairing code, and select the Windows environment.
3. Open a project in that environment and pick a Harness from the composer's Agent / Model selector.

## Troubleshooting

First, make sure regular Codex tasks work over Remote Control. Pairing failures, missing environments, and account authorization errors come from Remote Control itself, not codexhost.

- **`unknown variant codexhost/harness/inspect`**: upgrade and restart codexhost on both computers, then reconnect the environment.
- **Bridge fails to start, or `no active process for process handle`**: make sure Codex Desktop on Windows was launched through codexhost, restart it, and reconnect the environment.
- **Initialization times out after Windows restarts**: just retry.
- **`Host remote-control:… is a non-Windows controlled machine`**: the controlled machine is not Windows, so its Remote Control relay cannot start the codexhost bridge. Native Codex tasks keep working; connect over [SSH](remote-ssh-host.md) to use Harnesses there.
- **Codex works but no Harnesses show up**: run connection diagnostics on your computer, then check that the Harness is installed and signed in on Windows.
- **`Claude inbound is disabled`**: Claude Code integration is turned off in codexhost on the Windows machine. Turn it on and try again.
