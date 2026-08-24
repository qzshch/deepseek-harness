# Agent Note: the settings and credential planes ride the browser-trust fence

Status: implemented

English | [中文](2026-08-24-remote-settings-access.zh.md)

## Problem

A deployment that serves the GUI from a trusted authority — a Tailscale or LAN IP the Web runtime derives into `trustedHosts`, or a declared `trustedHosts` name — could load the app but not use it: the settings data plane (`settings.describe`/`update`/`replace`/`mutate`) and the credential plane (`credentials.describe`/`set`/`unset`) were loopback-pinned, so a trusted remote browser saw the Models page refuse to load the provider directory, and the theme, locale, and onboarding preferences had no durable home. The client paid for the asymmetry a second time: every settings consumer carried a dual mode — a wire scope for loopback pages and a process-local memory fallback everywhere else — and the welcome acknowledgement was wired on loopback with a process-local stand-in for the rest.

## Decision

The pin leaves the settings data plane and the credential plane. Both now ride the same `trustedHosts` fence as every other `/api` method: a browser that can load the app at all can read and write configuration and credentials, and a browser the deployment never declared is refused on them like on every other method. A deployment that trusts a serving authority — the Web runtime derives non-internal IPv4 literals from an all-interfaces server config, and `trustedHosts` names the rest — gets the full configuration UI with no extra configuration.

The loopback-pinned set is what acts on the Host desktop or carries a draft secret: `host.pickDirectory` and `host.openPath` (native dialogs and a hand-off to the host's own screen and default applications), `settings.openDocument` (materializes the settings document and hands it to a native editor on that desktop), `llm.discoverModels` (a draft credential plus a caller-chosen URL the Host fetches), and the agent-preset authoring plane `agentPreset.read`/`copy`/`openDocument`/`remove` (the composition names the plugins a session runs). `agentPreset.list`/`select` and the model catalog stay ordinary.

The client wires every settings scope through the fence; the memory fallback is gone. A refused read converges a scope that never loaded to a terminal `unavailable` status (a scope already holding a section keeps it through a refused refresh), and a refused write leaves the local preference standing. The welcome step wires its durable acknowledgement the same way and shows a localized error line — inside the blocking modal — when the namespace cannot be read.

The security framing is unchanged: the fence is a reachability policy, not authentication. What makes this safe is structural — a browser that reaches any `/api` method has already passed the fence, so "the app works but settings are refused" cannot occur on a functional deployment; the denied-read states a client renders exist only for transient transport failures.

## Alternatives considered

- **A config flag that unpins the planes per deployment.** Rejected: the flag toggles the entire configuration plane per deployment without adding a security property the fence does not already provide — a deployment that trusts an authority has already declared that surface reachable — and every consumer keeps carrying both transports.
- **Unpin the writes but keep the reads pinned.** Rejected: a read/write split strands `settings.describe`, which returns the exposed configuration, on loopback alone while a trusted remote writes blind, and splits one plane across two transports in every client consumer.
- **Keep the process-local fallback for refused deployments.** Rejected: the dual mode is the cost this decision removes; a trusted deployment is the normal case now, and a refused read's `unavailable` status already gives a denied scope a terminal, honest state.

## Consequences

- Trusted remote deployments — including a Tailscale IP the runtime derives into `trustedHosts` — get the full settings and credentials UI. An untrusted browser converges its settings scopes to `unavailable`, and theme and locale keep their provisional system- and navigator-derived preferences.
- `settings.openDocument`, the `host.*` desktop actions, `llm.discoverModels`, and agent-preset authoring stay loopback-local. The pin set is asserted over a real HTTP server in the connection suite: a trusted host 404s on the unpinned planes (the carrier's answer — the fence passed) and 403s on the pins, while an undeclared host 403s on both.
- The settings scope snapshot loses its `mode` field, and the welcome modal's error state is the visible face of a refused welcome read.
- The loopback pinning of the configuration plane that this note supersedes in part is [the configuration-plane boundary note](2026-07-30-config-plane-boundaries.md); the fence itself is [the browser-trust boundary note](2026-07-28-api-browser-trust-boundary.md); the persistence boundary of remote preferences is [the Host-backed preferences note](../bug-fix/2026-08-06-host-backed-web-preferences.md); the welcome step's durable field is [the shared-modal onboarding note](../feature/2026-08-13-shared-modal-product-onboarding.md).
