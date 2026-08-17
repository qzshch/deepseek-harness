# Agent Note: Persist fatal process errors to a crash log before exit

Status: implemented

English | [中文](2026-08-17-crash-log-persistence.zh.md)

## Problem

A long-running `dsh` surface (the web server) died silently overnight: the browser reported `connection refused` on the next morning, but nothing on disk explained why. The failure mode is the process-level one this package already guards — a fatal `unhandledRejection` is turned into one labelled stderr line and `exit(1)` by `installFailLoud` — yet that diagnostic is only as durable as the launching shell's stderr capture. A surface started without a terminal or redirect (a hidden `Start-Process`, a scheduled task, a bat launcher) loses the line entirely, leaving a 5-hour service outage with no crash stack, no Windows error report (the exit is a clean process exit, not a native crash), and no session-log tail (the process died before the next durability checkpoint). `uncaughtException` was worse: nothing handled it, so Node's default printed to stderr and exited without any record either.

## Decision

Every fatal process error on the `dsh` surfaces now lands in `$DSH_HOME/logs/crash.log` before the process exits, independent of how stderr was captured:

- `createCrashLog(homeDir)` (new in `packages/boot/app-boot`) returns a best-effort synchronous sink that appends a timestamped line to `$homeDir/logs/crash.log`, creating the `logs/` directory on first write. It never throws: a log that cannot be written (full disk, ACL) must not mask the reported error.
- `installFailLoud` gained an optional fourth `log` parameter; the handler passes the exact diagnostic line to the sink synchronously, before the stderr write and the awaited `release`, so a hang in the release hook cannot swallow the recorded reason.
- `installUncaughtCrashLog` (new) registers a fatal `uncaughtException` handler with the same labelled line through stderr and the optional sink before `exit(1)`, keeping Node's default fail-closed behavior while making the crash recoverable for diagnosis.
- `apps/cli/src/profile-boot.ts` wires both into every `dsh` surface with `createCrashLog(resolveDshHome())`.

Fail-closed behavior is unchanged: unhandled rejections and uncaught exceptions still exit 1. This change only makes the reason durable.

## Alternatives considered

**Change the failure mode for long-lived surfaces** (log the rejection and keep running instead of exiting). Rejected: it reverses the fail-closed contract that `installFailLoud` documents and tests, and an unhandled rejection can indicate corrupted durable state that continuing would write through. Recording first is the conservative step; revisiting the exit policy is a separate decision with its own note.

**Have each bin write the log path itself.** Rejected: the sink, its directory creation, and its never-throw contract belong with the fail-loud machinery they serve, so every surface (including `dsh-acp-demo`) inherits them from one owner.

## Consequences

A crash of any `dsh` surface now leaves `~/.dsh/logs/crash.log` with the timestamped stack of the first fatal rejection or uncaught exception, so the next outage is diagnosable without a captured stderr. The `installFailLoud` signature grew one optional parameter; existing callers that pass no `log` behave exactly as before. The new `uncaughtException` handler exits 1 where Node's default also exited 1, so no exit-code contract changed.

## Testing

`packages/boot/app-boot/tests/app-boot.spec.ts` covers: `createCrashLog` appends timestamped lines under `logs/` (creating the directory) and never throws when the target is a blocking file; `installFailLoud` passes the diagnostic line to the sink before the stderr write; `installUncaughtCrashLog` writes the labelled stack, records it through the sink, exits 1, stringifies non-Error values, falls back to the message without a stack, and its uninstaller removes the handler (including the default real-process arm, which is immediately uninstalled so the suite leaks no handler).
