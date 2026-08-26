import { describe, expect, it, vi } from 'vitest'

type SpawnArgs = Parameters<typeof import('node:child_process').spawn>

const spawnArgs = vi.hoisted(() => [] as SpawnArgs[])

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: SpawnArgs) => {
      spawnArgs.push(args)
      return actual.spawn(...args)
    },
  }
})

import { spawnSubprocess } from '../src/spawn.ts'

describe('spawn window suppression', () => {
  it('spawns with windowsHide so a console-less host never gets a visible console', async () => {
    const running = spawnSubprocess({
      argv: [process.execPath, '-e', ''],
      cwd: process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 1024 },
        stderr: { maxBytes: 1024 },
      },
      graceMs: 3_000,
    })
    await running.done
    expect(spawnArgs.length).toBeGreaterThan(0)
    const [, , options] = spawnArgs[0]!
    expect(options.windowsHide).toBe(true)
  })
})
