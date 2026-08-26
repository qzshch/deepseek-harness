# Agent Note: Hide the subprocess console window on Windows

Status: implemented

English | [中文](2026-08-27-subprocess-windows-console-window.zh.md)

## Problem

On Windows, spawning a console program (pwsh, bash, git, …) from a console-less host process gives the child a fresh, visible console window for every spawn. A DSH web server launched from a terminal that has since closed has no console to inherit, so every `pwsh`/`bash` tool call popped a pwsh.exe window in front of the user.

Node only sets the `CREATE_NO_WINDOW` creation flag when `windowsHide: true` is passed; `dsh-subprocess-local`'s `spawnSubprocess` and `taskkillProcessTree` did not set it.

## Decision

Set `windowsHide: true` on the `spawn` in `spawnSubprocess` and on the `spawnSync` in `taskkillProcessTree` (`packages/subprocess/subprocess-local/src/spawn.ts`). On Windows this maps to `CREATE_NO_WINDOW` — the child gets no visible console while stdio pipes still carry its output; on POSIX the option is ignored, so the change is behavior-neutral everywhere else.

All subprocess consumers (the pwsh and bash tool executors) route through `ctx.subprocess.spawn`, so one call-site fix covers every spawn; `taskkill` is included because process-tree teardown would otherwise pop the same window.

## Alternatives considered

**Pass `-WindowStyle Hidden` to pwsh.** Rejected: pwsh 7 does not support `-WindowStyle` (only Windows PowerShell 5.1 does), and it would not cover bash or any other console child.

**Attach the server to a hidden console at startup.** Rejected: this is deployment-shaped, does not survive a launcher change, and leaves every other console-less host process exposed to the same pop-up.

## Consequences

Console children spawned by the DSH server no longer flash a window, regardless of how the server was launched. Nothing else changes: stdio collection, signal escalation, and tree teardown are untouched.

## Testing

`packages/subprocess/subprocess-local/tests/spawn-windows-hide.spec.ts` spies on `node:child_process.spawn` and pins that `spawnSubprocess` passes `windowsHide: true`. The pop-up itself was verified operationally on the affected host (a console-less `dsh web` server) after applying the same edit to the installed package: tool calls no longer open a window.
