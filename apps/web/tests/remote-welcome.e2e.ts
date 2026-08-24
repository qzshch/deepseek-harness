// A trusted non-loopback browser rides the same trust fence as every other
// /api method, so the welcome acknowledgement is durable for it too: Continue
// writes it through the settings API into the Host settings document, and a
// reload loads it back, so the notice does not return. The untrusted face — a
// refused welcome read converging to the error state — is covered by the
// welcome-store unit suite.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, webSnapshotMode,
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_COPY, WELCOME_NOTICE_SETTINGS_NAMESPACE,
  type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: remote welcome notice', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      remoteAuthority: 'remote.localhost',
      welcomeNoticePending: true,
    })
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      locale: ZH_BROWSER_LOCALE,
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('#root', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('acknowledges durably and does not present the notice again after reload', async () => {
    const welcome = page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title })
    await welcome.waitFor({ timeout: 15_000 })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(true)

    await welcome.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel }).click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })
    await expect.poll(
      () => page.locator('#root').evaluate(root => (root as HTMLElement).inert),
      { timeout: 15_000 },
    ).toBe(false)

    // The acknowledgement landed in the Host settings document through the
    // fence-guarded wire, not in this browser's process memory.
    const settingsDocument = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8').catch(() => '')
    expect(settingsDocument).toContain(WELCOME_NOTICE_SETTINGS_NAMESPACE)
    expect(settingsDocument).toContain(WELCOME_NOTICE_ACK_FIELD)

    const reloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, reloadWarnings)
    await page.waitForSelector('#root', { timeout: 30_000 })
    await expect.poll(
      () => page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title }).count(),
      { timeout: 15_000 },
    ).toBe(0)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
