# Agent Note: the client's settings dual mode leaves the browser

Status: implemented

English | [中文](2026-08-30-remote-settings-access-v2.zh.md)

## Problem

The current baseline's server side has already removed the method-level pinning from the settings and credential planes: the API surface carries no loopback tier, and the browser-trust fence (`src/api-request-trust.ts`) applies uniformly to every `/api` method. The client still paid for the old asymmetry, though: its settings consumers carried a dual mode — the shared `settings.describe` mirror and every scope knew a `host`/`memory` mode, a scope on a non-loopback page never crossed the wire, and its snapshot started `unavailable` — and the welcome acknowledgement fell back to a process-local stand-in off loopback. A trusted, authenticated remote browser (a `trustedHosts` authority, cookie-authenticated through the fence) could load the app but not use its configuration surfaces: the Models page refused to load the provider directory, theme and locale had no durable home, and the welcome notice re-presented after every reload.

## Decision

The client drops the dual mode. Every settings scope now rides the wire through the fence; the settings data plane keeps no browser-identity gate, and no method-level pin is reintroduced on the server side.

- The shared mirror's status narrows to `idle | loading | ready`. A read that settles without an answer holds the error and stays `idle`, retryable; the mirror no longer knows a terminal state.
- Terminal unavailability converges at the scope layer. `convergeDeniedRead` settles a scope that never held a section to `unavailable` once the mirror holds an error and no view; a scope already holding a section keeps it through a refused refresh and returns to `ready` on the next successful read.
- `SettingsScopeSnapshot` loses its `mode` field, and the scope's `writable` reflects the durable document.
- The welcome acknowledgement is durable-only: the step compares and writes `ui-onboarding.welcomeNoticeVersion` in the Host settings plane, and a read that never answers shows a localized unavailable line inside the modal.
- The open-document action registers for every browser: its availability derives from the shared mirror's `hasDocument` answer instead of the page's loopback identity. The Host still materializes the document and hands it to its own desktop's native editor, so the action remains a desktop hand-off even when a remote page triggers it.

The security framing is unchanged: the fence is a reachability policy, not authentication. What makes this safe is structural — a browser that reaches any `/api` method has already passed the fence, so "the app loads but settings are refused" cannot occur on a functional deployment; the denied-read convergence a scope renders serves refusals and transient transport failures alike.

## Alternatives considered

- **Re-pin the settings plane per method on the current baseline.** Rejected: it would recreate the asymmetry this line of work removes, on the client side and the server side at once, for a security property the fence already provides.
- **Keep the memory mode as the default for remote or refused browsers.** Rejected: the dual mode is exactly the cost being removed; a trusted remote browser is the normal case now, and the scope's `unavailable` convergence already gives a refused read a terminal, honest state.
- **Hold the terminal `unavailable` in the shared mirror itself.** Rejected: the mirror is the single `settings.describe` reader for every scope; one failed read must stay retryable without making every dependent scope terminally unavailable. Convergence belongs at the scope layer, where a section's lifecycle is owned.

## Consequences

- A trusted, authenticated remote browser gets the full settings and credential plane. The welcome acknowledgement persists in the Host document and does not re-present after a reload; the remote welcome e2e asserts that durable behavior end to end.
- `SettingsScopeSnapshot` loses `mode`, and `SettingsMirrorSnapshot` loses `unavailable`. The scope's `unavailable` state now has a single entry: convergence on a held error with no view.
- The open-document action registers for every browser. It remains a desktop hand-off — the Host resolves the provider path, materializes the document, and opens its native editor — so a remote page's trigger acts on the Host desktop, not the page's own machine.
- This note re-lands the client side of the server-side pin removal recorded by the 2026-08-24 remote-settings-access decision (kept on the `legacy/remote-settings-access` branch) and supersedes that note's `settings.openDocument` pin, which the open-document registration here removes. The fence itself is [the browser-trust boundary note](2026-07-28-api-browser-trust-boundary.md); the pin's original configuration-plane framing is [the configuration-plane boundary note](2026-07-30-config-plane-boundaries.md); the shared mirror is [the settings-describe mirror note](2026-08-17-settings-describe-mirror.md); the persistence boundary of remote preferences is [the Host-backed preferences note](../bug-fix/2026-08-06-host-backed-web-preferences.md); the welcome step's durable field is [the shared-modal onboarding note](../feature/2026-08-13-shared-modal-product-onboarding.md).