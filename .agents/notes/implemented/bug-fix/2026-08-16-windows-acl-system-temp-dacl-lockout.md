# Agent Note: Self-contain private temp DACLs before the capability grant

Status: implemented

English | [中文](2026-08-16-windows-acl-system-temp-dacl-lockout.zh.md)

## Problem

On a Windows host whose user `TMP`/`TEMP` resolves to the SYSTEM temp dir (a machine-level `TMP=TEMP=C:\Windows\Temp` with no user-level override), every sandboxed command failed with `sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host` and the runner detail `windows-acl-run: --temp is not an existing directory: C:\WINDOWS\TEMP\dsh-XXXXXX`.

The directory existed — the seam created it milliseconds earlier via `mkdtempSync(join(tmpdir(), 'dsh-'))` — but the grant's `SetNamedSecurityInfoW` re-apply had made it invisible to its creator: `existsSync` and every `accessSync` returned false for the user who just created it, so the runner's `requireDirectory('--temp', …)` gate (a plain `existsSync`) reported a missing directory. The tool layer re-classified the runner failure as `SandboxUnavailableError`, fail-closed by design.

Reproduced directly on the affected machine against the published package: a fresh `mkdtempSync` child of `C:\WINDOWS\TEMP` is fully accessible before `AclWriteGrant.add`, and fully locked out (R/W/X all false, `icacls` itself denied) after it. The same code path under `%LOCALAPPDATA%\Temp` is harmless — the private directory's inherited ACEs there carry a creator full-control grant that survives the re-apply.

## Decision

A revocable (private temp) path is made **DACL self-contained before its capability grant**: `selfContainDacl` (new in `packages/sandbox/sandbox-windows-acl`) reads the directory's current DACL and regenerates every ACE as an explicit entry — inheritance bits (OI/CI/NP/IO) preserved verbatim, the `ACE_INHERITED` marker dropped — rebuilding the ACL from scratch through `SetEntriesInAclW` and applying it via `SetNamedSecurityInfoW`. With no inherited ACEs left, the grant's own re-apply cannot lose them to re-propagation, so the creator keeps exactly the access the inherited shape had granted.

The call sites are the two places a private temp directory is granted, so every path is covered:

- `AclWriteGrant.add(path)` on a revocable path (the seam's `materializeAclGrant` in `sandbox-local` calls this with `standing: false`);
- `AclSandbox.init()` under `manageDacls: true` (the agentless runner flow, which creates the private child itself).

Workspace roots are deliberately NOT self-contained: `add(path, standing: true)` skips it, and `AclSandbox` never applies it to `writableDirs`. Their inherited ACEs and the propagation relationship are the standing reuse cache — materializing them would rewrite the ACL semantics of the whole tree.

As a safety net, `grantWrite` now re-verifies the creator's access (`accessSync(path, R_OK | W_OK)`) after a real apply and throws the true cause instead of letting the runner misreport a missing directory. An `ENOENT` (the directory does not exist — a caller bug, not a lockout) is left to the caller's own error handling.

## Alternatives considered

**Fall back to a user-owned temp root in `sandbox-local`** (choose `%LOCALAPPDATA%\Temp` when `tmpdir()` is a system dir). Rejected as the primary fix: it relocates the failure instead of removing it — the ACL re-apply hazard stays for any future temp root whose inherited shape lacks a creator grant, including the agentless runner path, which never consults `sandbox-local`. The self-containment fix makes the grant safe under ANY temp root; the fallback remains a reasonable operator-level workaround and is documented as such.

**Verification only (the `accessSync` check without self-containment).** Rejected: it converts the misleading message into a clear one but leaves every sandboxed command failing on the affected host. Verification survives as the safety net for shapes the materialization does not anticipate.

**Grant the creator an explicit full-control ACE before the capability grant.** Simpler to implement (one extra merge), but it rewrites the directory's access semantics — the creator gains full control the inherited shape may not have given — and it does not preserve the other inherited ACEs (SYSTEM, Administrators, Everyone read) that the re-apply can also drop. Materialization preserves the exact effective ACL.

**Materialize unconditionally inside `mergeAndApply`.** This would cover workspace roots too. Rejected: stripping the inherited marker on a workspace root changes what its descendants inherit and turns the standing reuse cache into a one-time snapshot.

## Consequences

On the affected host shape the sandbox now works end to end: the private temp directory keeps its creator's access across the grant, the runner's `existsSync` gate passes, and the confined child executes under the restricted token. A private temp directory's DACL no longer tracks its parent's ACL afterwards — irrelevant for a directory that lives for one session and is deleted, and safer than inheriting from an unpredictable root.

`grantWrite` on a directory whose re-apply genuinely locks the creator out now throws with the real cause (naming the temp root's inherited-ACE shape and the `TMP`/`TEMP` remedy) instead of the runner's misleading `--temp is not an existing directory`.

The `AclWriteGrant` and `AclSandbox` contracts are unchanged; the new `selfContainDacl` export is additive.

## Testing

`packages/sandbox/sandbox-windows-acl/tests/self-contain.spec.ts` pins three behaviors: `selfContainDacl` regenerates inherited ACEs as explicit entries (the DACL gains entries without the inherited marker); `AclWriteGrant.add` under a system-temp-shaped parent keeps the creator accessible with the capability ACE visible and revocable; and — on hosts where the real system temp root is writable — the full `add` flow under it keeps the creator accessible across the re-apply (self-skips elsewhere). The affected machine reproduced the lockout against the published package before this change and passes the fixed path against the source, both under the real `C:\WINDOWS\TEMP`.
