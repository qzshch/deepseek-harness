# Agent Note: Trusted-hosts loopback surface

Status: implemented

English | [中文](2026-09-26-trusted-hosts-loopback-surface.zh.md)

## Problem

A deployment that binds `0.0.0.0` and lists its served names in `trustedHosts` still classifies every non-loopback page as unprivileged: `ctx.connection.isLoopback` is computed from the page hostname alone, so host-persisted client features (the settings describe mirror and the settings document controller) report "settings are unavailable in this browser" on LAN and tailnet pages even though the request fence already vouches for those authorities.

## Decision

The Host injects its configured `trustedHosts` into the served page next to `__DSH_CONNECTION_RECOVERY__`, and the client connection classifies a page as loopback when its authority matches an entry: a bare `host` entry matches any port, a `host:port` entry (bracketed IPv6 included) also requires the port, and a page without a port never matches a ported entry. Only the two settings consumers read this fact today; the fence, browser authentication, and the client-IP allowlist are unchanged.

## Alternatives considered

**Always treat the settings mirror as host-persisted.** That would grant the surface to pages the deployment never vouched for; the authority list keeps the decision with the fence's own trust set.

**Publish Host-computed connection facts.** Loopback depends on the page location the Host never sees; the injected list keeps the classification client-side and fail-closed when absent.

## Consequences

Pages served from a trusted name gain host-persisted settings on their next load; deployments that never leave loopback see no behavioral change because the global defaults to an empty list.
