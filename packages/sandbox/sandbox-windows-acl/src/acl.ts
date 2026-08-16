/**
 * ACL editing helpers: grant/revoke a capability SID on a directory via
 * SetEntriesInAclW + SetNamedSecurityInfoW (the same calls the POC uses, with
 * the failure handling the POC lacks). Every API call is checked and every
 * failure is reported with the API name, the exact Win32 code, the formatted
 * system text, and the affected path.
 *
 * Concurrency: grants are read-merge-write against the directory's CURRENT
 * DACL, and the whole get-merge-set sequence runs under a per-path exclusive
 * LockFileEx lock (see {@link withPathLock}) so concurrent sandbox instances
 * cannot clobber each other's ACEs.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/acl
 */

import { createHash } from 'node:crypto'
import { accessSync, constants, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { allocOverlapped, allocPtrSlot, decodePtr, decodeUint8At, decodeUint16At, decodeUint32At, getTempPath, isInvalidHandle, isNullPtr, ptrAddress, sameSidAt, throwLastError, throwWin32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import * as abi from './win32-abi.ts'

/**
 * Pack one EXPLICIT_ACCESS_W (48 bytes, layout verified by abi-probe.cpp):
 * perms@0, mode@4, inheritance@8, Trustee@16 { pMultipleTrustee@16,
 * MultipleTrusteeOperation@24, TrusteeForm@28, TrusteeType@32, ptstrName@40 }.
 * `permissions` is the access mask; the POC passes 0 for REVOKE_ACCESS, which
 * removes every ACE for the trustee.
 * @param sidPtr - the trustee SID the entry names.
 * @param mode - the access mode (GRANT_ACCESS or REVOKE_ACCESS).
 * @param permissions - the access mask to grant (0 for REVOKE_ACCESS).
 * @returns the packed entry buffer.
 */
export function buildExplicitAccess(sidPtr: NativePtr, mode: number, permissions: number): Buffer {
  const entry = Buffer.alloc(abi.EXPLICIT_ACCESS_W_SIZE)
  entry.writeUInt32LE(permissions, 0) // grfAccessPermissions
  entry.writeUInt32LE(mode, 4) // grfAccessMode
  entry.writeUInt32LE(abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, 8) // grfInheritance: OI|CI
  entry.writeUInt32LE(abi.NO_MULTIPLE_TRUSTEE, 24) // Trustee.MultipleTrusteeOperation
  entry.writeUInt32LE(abi.TRUSTEE_IS_SID, 28) // Trustee.TrusteeForm
  entry.writeUInt32LE(abi.TRUSTEE_IS_UNKNOWN, 32) // Trustee.TrusteeType
  entry.writeBigUInt64LE(ptrAddress(sidPtr), 40) // Trustee.ptstrName = the capability SID
  return entry
}

/**
 * One lock file per protected path: `<GetTempPathW()>\dsh-acl-locks\<first 16
 * hex of sha256(lowercased path)>.lock`. The lock root derives from
 * GetTempPathW (never from runner argv or DSH_HOME), and the lowercasing
 * maps Windows's case-insensitive path spellings onto one lock.
 * @param api - the binding table.
 * @param path - the protected directory (absolute).
 * @returns the lock file path for that directory.
 */
export function lockFilePath(api: Win32Bindings, path: string): string {
  const digest = createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 16)
  return join(getTempPath(api), 'dsh-acl-locks', `${digest}.lock`)
}

/**
 * Run `action` holding the per-path exclusive lock: CreateFileW
 * (OPEN_ALWAYS, shared read/write but NOT delete — a deletable lock file
 * could be removed and recreated under the holder, letting two processes
 * hold "the same" lock), then a one-byte LockFileEx
 * (LOCKFILE_EXCLUSIVE_LOCK, zeroed OVERLAPPED = lock from offset 0 on the
 * synchronous handle — see allocOverlapped for why not NULL), then
 * UnlockFileEx + CloseHandle. Fail-closed: open/lock/unlock/close failures
 * throw like every other Win32 call in this package; an `action` failure
 * still unlocks (best-effort) and rethrows the original error.
 * @param api - the binding table.
 * @param path - the protected directory (absolute).
 * @param action - the get-merge-set sequence to serialize.
 * @returns the action's result.
 */
export function withPathLock<T>(api: Win32Bindings, path: string, action: () => T): T {
  const lockPath = lockFilePath(api, path)
  mkdirSync(dirname(lockPath), { recursive: true })
  const handle = api.createFileW(
    lockPath,
    abi.GENERIC_READ | abi.GENERIC_WRITE,
    abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE,
    null, abi.OPEN_ALWAYS, 0, null,
  )
  if (isInvalidHandle(handle)) throwLastError(api, 'CreateFileW', lockPath)
  const overlapped = allocOverlapped() // stays zeroed: offset 0, hEvent NULL
  if (api.lockFileEx(handle, abi.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(handle) // best-effort on the lock-failure path
    throwWin32(api, 'LockFileEx', win32Code, lockPath)
  }

  let result: T
  try {
    result = action()
  } catch (error) {
    // Best-effort release on the action-failure path: cleanup failures must
    // not mask the action's error.
    api.unlockFileEx(handle, 0, 1, 0, overlapped)
    api.closeHandle(handle)
    throw error
  }
  if (api.unlockFileEx(handle, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(handle) // best-effort on the unlock-failure path
    throwWin32(api, 'UnlockFileEx', win32Code, lockPath)
  }
  if (api.closeHandle(handle) === 0) throwLastError(api, 'CloseHandle', `lock file ${lockPath}`)
  return result
}

/**
 * Read the directory's current explicit DACL via GetNamedSecurityInfoW.
 * Allocation contract (the POC's RevokeAccess, minus its missing checks): the
 * returned ACL pointer sits INSIDE the security descriptor allocation — only
 * the descriptor may be LocalFree'd, and it must not be freed before
 * SetEntriesInAclW has consumed the ACL. Freeing the ACL pointer itself
 * corrupts the heap (verified the hard way).
 * @param api - the binding table.
 * @param path - the directory whose DACL is read.
 * @returns the current explicit DACL (null when the directory carries none) and its owning descriptor.
 */
function readCurrentDacl(api: Win32Bindings, path: string): { oldAcl: NativePtr | null; descriptor: NativePtr | null } {
  const ownerSlot = allocPtrSlot()
  const groupSlot = allocPtrSlot()
  const daclSlot = allocPtrSlot()
  const saclSlot = allocPtrSlot()
  const descriptorSlot = allocPtrSlot()
  const readResult = api.getNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION,
    ownerSlot, groupSlot, daclSlot, saclSlot, descriptorSlot,
  )
  if (readResult !== abi.ERROR_SUCCESS) throwWin32(api, 'GetNamedSecurityInfoW', readResult, path)
  return { oldAcl: decodePtr(daclSlot), descriptor: decodePtr(descriptorSlot) }
}

/**
 * Shared tail of the ACL-edit helpers: apply `newAcl` to the directory's
 * DACL, freeing the descriptor allocation (which owns the old ACL) before the
 * apply and the merged ACL after it, checking every call and reporting with
 * the caller's label. The caller owns `newAcl` and the descriptor block
 * through this call; both are freed here.
 * @param api - the binding table.
 * @param path - the directory the DACL edit applies to.
 * @param newAcl - the merged ACL to apply (SetEntriesInAclW output).
 * @param descriptor - the descriptor allocation owning the read old ACL, or null.
 * @param label - the caller's name for error details.
 */
function applyAcl(
  api: Win32Bindings,
  path: string,
  newAcl: NativePtr,
  descriptor: NativePtr | null,
  label: string,
): void {
  // The descriptor block (oldAcl included) is dead after the merge — free it
  // before applying, exactly like the POC.
  const freedDescriptor = descriptor !== null ? api.localFree(descriptor) : null
  const applyResult = api.setNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION,
    null, null, newAcl, null,
  )
  const freedNew = api.localFree(newAcl)
  if (applyResult !== abi.ERROR_SUCCESS) throwWin32(api, 'SetNamedSecurityInfoW', applyResult, `${label}(${path})`)
  if (freedDescriptor !== null && !isNullPtr(freedDescriptor)) throwLastError(api, 'LocalFree', `${label}(${path}) descriptor`)
  if (!isNullPtr(freedNew)) throwLastError(api, 'LocalFree', `${label}(${path}) new ACL`)
}

/**
 * Shared tail of grantWrite and revokeWrite: merge `entry` into `oldAcl`
 * (null = no explicit DACL yet; SetEntriesInAclW builds one from scratch),
 * free the descriptor before applying the merged ACL, apply it, then free the
 * merged ACL — checking every call and reporting with the caller's label.
 * @param api - the binding table.
 * @param path - the directory the DACL edit applies to.
 * @param entry - the EXPLICIT_ACCESS_W to merge (grant or revoke).
 * @param oldAcl - the current explicit DACL (from {@link readCurrentDacl}).
 * @param descriptor - the descriptor allocation owning `oldAcl`.
 * @param label - the caller's name for error details.
 */
function mergeAndApply(
  api: Win32Bindings,
  path: string,
  entry: Buffer,
  oldAcl: NativePtr | null,
  descriptor: NativePtr | null,
  label: string,
): void {
  const newAclSlot = allocPtrSlot()
  const mergeResult = api.setEntriesInAclW(1, entry, oldAcl, newAclSlot)
  if (mergeResult !== abi.ERROR_SUCCESS) {
    if (descriptor !== null) api.localFree(descriptor) // frees the ACL block too
    throwWin32(api, 'SetEntriesInAclW', mergeResult, `${label}(${path})`)
  }
  const newAcl = decodePtr(newAclSlot)
  if (newAcl === null) {
    if (descriptor !== null) api.localFree(descriptor)
    throwWin32(api, 'SetEntriesInAclW', api.getLastError(), `${label}(${path}): null new ACL`)
  }
  applyAcl(api, path, newAcl, descriptor, label)
}

/**
 * Make a directory's DACL self-contained: every ACE inherited from the
 * parent is materialized as an explicit ACE (its inheritance bits preserved,
 * the {@link abi.INHERITED_ACE} marker dropped). A later
 * SetNamedSecurityInfoW re-apply — the grant/revoke merge path — then cannot
 * lose those ACEs to re-propagation: with no inherited ACEs left, Windows
 * applies the new DACL as-is instead of recomputing inheritance from the
 * parent. This matters for PRIVATE temp directories created under a system
 * temp root like `C:\Windows\Temp`, whose inherited-ACE shape can otherwise
 * leave the creator with no usable ACE after a re-apply (the directory
 * becomes invisible to the user who just created it — `existsSync` false and
 * every sandboxed command fail-closed). Callers apply it to a fresh temp
 * directory BEFORE granting the capability ACE; workspace roots must NOT be
 * passed here (their inherited ACEs are the standing reuse cache and the
 * propagation relationship is intentional).
 *
 * Fail-closed: an unsupported ACE type (DACLs may only carry allow/deny
 * ACEs), an implausible ACL layout, or any Win32 failure throws without
 * applying a partial DACL — an ACE is never silently dropped.
 * @param api - the binding table.
 * @param path - the directory whose DACL is made self-contained.
 */
export function selfContainDacl(api: Win32Bindings, path: string): void {
  withPathLock(api, path, () => {
    const { oldAcl, descriptor } = readCurrentDacl(api, path)
    if (oldAcl === null) {
      // No DACL: a null DACL grants everyone full access and carries no
      // inherited ACEs that a re-apply could lose — already self-contained.
      if (descriptor !== null) {
        const freed = api.localFree(descriptor)
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `selfContainDacl(${path}) descriptor`)
      }
      return
    }
    const aclSize = decodeUint16At(oldAcl, 2)
    const aceCount = decodeUint16At(oldAcl, 4)
    if (aclSize < 8 || aclSize > 1_048_576) {
      if (descriptor !== null) api.localFree(descriptor)
      throw new Error(`selfContainDacl(${path}): implausible ACL size ${aclSize}`)
    }
    interface MaterializedAce {
      /** The ACE's access mask, carried verbatim. */
      mask: number
      /** The ACE's inheritance bits (OI|CI|NP|IO), carried verbatim. */
      inherit: number
      /** GRANT_ACCESS for an allow ACE, DENY_ACCESS for a deny ACE. */
      mode: number
      /** Absolute address of the ACE's inline SID inside the descriptor allocation. */
      sidAddress: bigint
    }
    const aces: MaterializedAce[] = []
    let hasInherited = false
    let offset = 8 // the first ACE follows the 8-byte ACL header
    for (let index = 0; index < aceCount; index++) {
      const aceSize = decodeUint16At(oldAcl, offset + 2)
      if (aceSize < 8 || offset + aceSize > aclSize) {
        if (descriptor !== null) api.localFree(descriptor)
        throw new Error(`selfContainDacl(${path}): implausible ACE at offset ${offset}`)
      }
      const aceType = decodeUint8At(oldAcl, offset)
      const mode = aceType === abi.ACCESS_ALLOWED_ACE_TYPE
        ? abi.GRANT_ACCESS
        : aceType === abi.ACCESS_DENIED_ACE_TYPE
          ? abi.DENY_ACCESS
          : undefined
      if (mode === undefined) {
        if (descriptor !== null) api.localFree(descriptor)
        throw new Error(`selfContainDacl(${path}): unsupported DACL ACE type ${aceType}`)
      }
      const aceFlags = decodeUint8At(oldAcl, offset + 1)
      if ((aceFlags & abi.INHERITED_ACE) !== 0) hasInherited = true
      aces.push({
        mask: decodeUint32At(oldAcl, offset + 4),
        inherit: aceFlags & abi.ACE_INHERIT_BITS,
        mode,
        // The SID is INLINE in the ACE (see hasExactGrant); the entry names
        // its address inside the descriptor allocation, which stays alive
        // until SetEntriesInAclW has consumed the entries.
        sidAddress: ptrAddress(oldAcl) + BigInt(offset + 8),
      })
      offset += aceSize
    }
    if (!hasInherited) {
      // No inherited ACEs to materialize — the DACL already re-applies intact.
      if (descriptor !== null) {
        const freed = api.localFree(descriptor)
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `selfContainDacl(${path}) descriptor`)
      }
      return
    }
    const entries = Buffer.alloc(aces.length * abi.EXPLICIT_ACCESS_W_SIZE)
    aces.forEach((ace, index) => {
      const entry = entries.subarray(index * abi.EXPLICIT_ACCESS_W_SIZE, (index + 1) * abi.EXPLICIT_ACCESS_W_SIZE)
      entry.writeUInt32LE(ace.mask, 0) // grfAccessPermissions
      entry.writeUInt32LE(ace.mode, 4) // grfAccessMode
      entry.writeUInt32LE(ace.inherit, 8) // grfInheritance (materialized bits)
      entry.writeUInt32LE(abi.NO_MULTIPLE_TRUSTEE, 24) // Trustee.MultipleTrusteeOperation
      entry.writeUInt32LE(abi.TRUSTEE_IS_SID, 28) // Trustee.TrusteeForm
      entry.writeUInt32LE(abi.TRUSTEE_IS_UNKNOWN, 32) // Trustee.TrusteeType
      entry.writeBigUInt64LE(ace.sidAddress, 40) // Trustee.ptstrName
    })
    // Rebuild from scratch: the old ACL is passed as null so EVERY ACE is
    // regenerated from the entries — inherited ACEs come out explicit.
    const newAclSlot = allocPtrSlot()
    const mergeResult = api.setEntriesInAclW(aces.length, entries, null, newAclSlot)
    if (mergeResult !== abi.ERROR_SUCCESS) {
      if (descriptor !== null) api.localFree(descriptor)
      throwWin32(api, 'SetEntriesInAclW', mergeResult, `selfContainDacl(${path})`)
    }
    const newAcl = decodePtr(newAclSlot)
    if (newAcl === null) {
      if (descriptor !== null) api.localFree(descriptor)
      throwWin32(api, 'SetEntriesInAclW', api.getLastError(), `selfContainDacl(${path}): null new ACL`)
    }
    applyAcl(api, path, newAcl, descriptor, 'selfContainDacl')
  })
}

/**
 * True when the explicit DACL already carries the EXACT write grant this
 * module would add (Allow ACE, OI|CI inheritance, {@link abi.GRANT_MASK}, the
 * capability SID). Every field is read through koffi.decode at pointer offsets —
 * no memcpy, no pointer arithmetic. The ACE's SID is INLINE (embedded in the
 * ACE after the 4-byte mask — there is no pointer to read; reading one
 * yields garbage addresses and crashed EqualSid, verified by gdb), so it is
 * compared field-by-field against the capability SID through bounded offset
 * reads ({@link sameSidAt}). A malformed header reads as "no exact grant"
 * so the caller falls back to the merge-apply path, which owns the robust
 * failure handling.
 * @param oldAcl - the current explicit DACL pointer (from {@link readCurrentDacl}).
 * @param sidPtr - the capability SID to match.
 * @returns whether the exact grant ACE is already present.
 */
function hasExactGrant(oldAcl: NativePtr, sidPtr: NativePtr): boolean {
  const aclSize = decodeUint16At(oldAcl, 2)
  const aceCount = decodeUint16At(oldAcl, 4)
  if (aclSize < 8 || aclSize > 1_048_576) return false // implausible: fall back to the merge path
  let offset = 8 // the first ACE follows the 8-byte ACL header
  for (let index = 0; index < aceCount; index++) {
    // ACE_HEADER: AceType@0, AceFlags@1, AceSize@2 (WORD);
    // ACCESS_ALLOWED_ACE: Mask@4, inline SID@8.
    const aceSize = decodeUint16At(oldAcl, offset + 2)
    if (aceSize < 8 || offset + aceSize > aclSize) return false // implausible: fall back to the merge path
    const exact = decodeUint8At(oldAcl, offset) === abi.ACCESS_ALLOWED_ACE_TYPE
      && decodeUint8At(oldAcl, offset + 1) === abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT
      && decodeUint32At(oldAcl, offset + 4) === abi.GRANT_MASK
    if (exact && sameSidAt(oldAcl, offset + 8, sidPtr, 0)) return true
    offset += aceSize
  }
  return false
}

/**
 * Post-apply creator-access check: after a DACL re-apply the CREATOR must
 * still be able to stat the directory (FILE_READ_ATTRIBUTES). Under a
 * system temp root whose inherited-ACE shape does not survive
 * SetNamedSecurityInfoW re-propagation, the re-apply can leave the creator
 * with no usable ACE — the runner's later existsSync gate then reports the
 * misleading "--temp is not an existing directory" and every sandboxed
 * command fails closed. Fail loudly here with the real cause instead. A
 * directory that does not exist (ENOENT) is a caller bug, not a lockout,
 * and is left to the caller's own error handling.
 * @param path - the directory whose DACL was just re-applied.
 * @param label - the caller's name for error details.
 */
function verifyCreatorAccess(path: string, label: string): void {
  try {
    accessSync(path, constants.R_OK | constants.W_OK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error(
      `${label}(${path}): after the DACL re-apply the directory is no longer accessible to its creator `
      + `(${error instanceof Error ? error.message : String(error)}); the temp root's inherited-ACE shape does not `
      + 'survive SetNamedSecurityInfoW re-propagation — point TMP/TEMP at a user-owned directory',
    )
  }
}

/**
 * Grant `GRANT_MASK` (Write+Delete, displays as "Modify") to the capability SID
 * on `path`, inheriting to subcontainers and objects. Idempotent: when the
 * directory's current explicit DACL already carries the exact ACE (the
 * per-session grant surviving from a previous server lifetime), the
 * SetNamedSecurityInfoW apply is SKIPPED — it would otherwise re-propagate
 * the identical ACE across the whole tree (eager inheritance; minutes on
 * large workspaces). Otherwise read-merge-write: the new ACE merges into the
 * directory's CURRENT explicit DACL (same shape as {@link revokeWrite}), so
 * pre-existing explicit ACEs survive. Runs under the per-path lock. The
 * directory must be owned by the caller (owner implicit WRITE_DAC) — same
 * precondition as the POC. After a real apply the creator's access is
 * re-verified ({@link verifyCreatorAccess}) so a re-propagation that locks
 * the creator out fails with the true cause instead of a misleading
 * missing-directory error at the runner boundary.
 * @param api - the binding table.
 * @param path - the directory whose DACL gains the grant (the workspace or temp root).
 * @param sidPtr - the capability SID the ACE names.
 */
export function grantWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): void {
  withPathLock(api, path, () => {
    const { oldAcl, descriptor } = readCurrentDacl(api, path)
    if (oldAcl !== null && hasExactGrant(oldAcl, sidPtr)) {
      // The exact ACE stands: releasing the descriptor is the whole operation.
      if (descriptor !== null) {
        const freed = api.localFree(descriptor)
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `grantWrite(${path}) descriptor`)
      }
      return
    }
    mergeAndApply(api, path, buildExplicitAccess(sidPtr, abi.GRANT_ACCESS, abi.GRANT_MASK), oldAcl, descriptor, 'grantWrite')
    verifyCreatorAccess(path, 'grantWrite')
  })
}

/**
 * Remove every ACE for the capability SID from the directory DACL (REVOKE_ACCESS
 * merge — other entries are preserved). Returns whether an ACE removal was
 * attempted (false when the directory carries no DACL at all).
 *
 * Runs under the per-path lock (the whole get-merge-set sequence); the
 * descriptor/ACL allocation contract lives on {@link readCurrentDacl}.
 * @param api - the binding table.
 * @param path - the directory whose DACL loses the capability-SID ACEs.
 * @param sidPtr - the capability SID whose ACEs are removed.
 * @returns whether an ACE removal was attempted (false when the directory carries no DACL at all).
 */
export function revokeWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): boolean {
  return withPathLock(api, path, () => {
    const { oldAcl, descriptor } = readCurrentDacl(api, path)
    if (oldAcl === null) {
      if (descriptor !== null) {
        const freed = api.localFree(descriptor)
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `revokeWrite(${path}) descriptor`)
      }
      return false
    }
    mergeAndApply(api, path, buildExplicitAccess(sidPtr, abi.REVOKE_ACCESS, 0), oldAcl, descriptor, 'revokeWrite')
    return true
  })
}
