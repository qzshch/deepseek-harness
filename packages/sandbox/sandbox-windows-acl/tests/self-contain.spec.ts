/**
 * selfContainDacl tests: a private temp directory's DACL is made
 * self-contained (inherited ACEs materialized as explicit ones) BEFORE the
 * capability ACE is granted, so a directory created under ANY temp root —
 * including a system root like `C:\Windows\Temp` — keeps its creator's
 * access across the grant's SetNamedSecurityInfoW re-apply. Without the
 * materialization, a system-temp-shaped parent can leave the creator with
 * no usable ACE after the re-apply (reproduced on this machine against the
 * real `C:\WINDOWS\TEMP`: existsSync flips true → false after grant.add).
 * Win32-only, like the other real-FFI suites.
 */

import { spawnSync } from 'node:child_process'
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AclWriteGrant, selfContainDacl, tempWriteSid } from '../src/index.ts'
import { win32Sync } from '../src/ffi.ts'

const isWin32 = process.platform === 'win32'

/** The directory DACL as icacls renders it (the operator-visible form). */
function icaclsText(path: string): string {
  const result = spawnSync('icacls', [path], { encoding: 'utf8' })
  expect(result.status, `icacls failed: ${result.stderr}`).toBe(0)
  return result.stdout
}

function accessible(path: string): { read: boolean; write: boolean } {
  let read = false
  let write = false
  try {
    accessSync(path, constants.R_OK)
    read = true
  } catch {
    /* denied */
  }
  try {
    accessSync(path, constants.W_OK)
    write = true
  } catch {
    /* denied */
  }
  return { read, write }
}

/** icacls argument list applying one grant (replace-trustee) to `path`. */
function grantAce(path: string, ace: string): string[] {
  return [path, '/grant:r', ace]
}

describe.skipIf(!isWin32)('selfContainDacl (private temp DACL self-containment)', () => {
  const scratchDirs: string[] = []
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-self-contain-'))
    scratchDirs.push(dir)
    return dir
  }

  it('materializes inherited ACEs as explicit ones (the DACL gains explicit entries)', () => {
    const dir = scratch()
    const child = mkdtempSync(join(dir, 'dsh-'))
    scratchDirs.push(child)
    const before = icaclsText(child)
    expect(before).toMatch(/\(I\)/u) // the child really inherits
    selfContainDacl(win32Sync(), child)
    const after = icaclsText(child)
    // The inherited ACEs are regenerated as EXPLICIT entries (no inherited
    // marker). A later SetNamedSecurityInfoW re-propagation may add inherited
    // ACEs back from the parent, but the explicit copies — the creator's
    // grants among them — survive the re-apply regardless of the parent's
    // shape, which is the point of the fix.
    expect(after).toMatch(/:(?!\(I\))/u)
  })

  it('AclWriteGrant.add on a system-temp-shaped parent keeps the creator accessible and the grant visible', () => {
    const parent = scratch()
    // Re-shape the parent like C:\Windows\Temp (inherited allow ACEs that
    // carry no creator read grant to a fresh child) before creating the
    // private child under it.
    const user = spawnSync('whoami', { encoding: 'utf8' }).stdout.trim()
    for (const ace of [
      'NT AUTHORITY\\SYSTEM:(OI)(CI)(RD,S)',
      'BUILTIN\\IIS_IUSRS:(OI)(CI)(RD,S)',
      'BUILTIN\\Users:(CI)(WD,AD,X,S)',
      `${user}:(OI)(CI)(F)`,
      'CREATOR OWNER:(OI)(CI)(IO)(F)',
    ]) {
      const result = spawnSync('icacls', grantAce(parent, ace), { encoding: 'utf8' })
      expect(result.status, `icacls ${ace} failed: ${result.stderr}`).toBe(0)
    }
    const child = mkdtempSync(join(parent, 'dsh-'))
    scratchDirs.push(child)
    const grant = AclWriteGrant.create(tempWriteSid(child))
    grant.add(child) // the fixed path: self-contain before the capability grant
    expect(accessible(child)).toEqual({ read: true, write: true })
    expect(icaclsText(child)).toContain(tempWriteSid(child))
    grant.dispose()
    expect(icaclsText(child)).not.toContain(tempWriteSid(child))
    expect(accessible(child)).toEqual({ read: true, write: true })
  })

  it('under a REAL system temp root, add keeps the creator accessible across the re-apply', () => {
    // The affected shape is the ambient temp root resolving to the SYSTEM
    // temp dir (C:\Windows\Temp). It only exists where that root is writable,
    // so the test self-skips elsewhere; on an affected host it exercises the
    // exact failure the fix targets.
    const systemRoot = process.env.SystemRoot
    if (systemRoot === undefined) return
    const systemTemp = join(systemRoot, 'Temp')
    let probe: string | undefined
    try {
      probe = mkdtempSync(join(systemTemp, 'dsh-probe-'))
    } catch {
      return // the system temp root is not writable here; the shape is absent
    }
    rmSync(probe, { recursive: true, force: true })
    const oldTmp = process.env.TMP
    const oldTemp = process.env.TEMP
    try {
      process.env.TMP = systemTemp
      process.env.TEMP = systemTemp
      const child = mkdtempSync(join(tmpdir(), 'dsh-'))
      scratchDirs.push(child)
      const grant = AclWriteGrant.create(tempWriteSid(child))
      grant.add(child)
      expect(accessible(child)).toEqual({ read: true, write: true })
      grant.dispose()
      expect(accessible(child)).toEqual({ read: true, write: true })
    } finally {
      if (oldTmp === undefined) delete process.env.TMP
      else process.env.TMP = oldTmp
      if (oldTemp === undefined) delete process.env.TEMP
      else process.env.TEMP = oldTemp
    }
  })
})
