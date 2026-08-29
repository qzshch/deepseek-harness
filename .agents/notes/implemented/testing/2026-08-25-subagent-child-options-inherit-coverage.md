# Agent Note: Subagent child-options inheritance coverage — ported empty-route assertion

Status: implemented

English | [中文](2026-08-25-subagent-child-options-inherit-coverage.zh.md)

## Problem

The local pre-merge branch `fix/subagent-inherit-parent-route` (commit `426f8699ba`, "inherit provider/model from parent session's latest request/header") was superseded upstream: `parentAgentOptionsForDelegation()` now owns the header-over-options waterfall in `child-agent.ts`, so the local code was dropped. Its five spec assertions for `resolveChildAgentOptions` were checked one by one against the upstream implementation to find which scenarios the new-baseline spec (`tests/child-agent.spec.ts`) still lacks.

Coverage mapping:

| Ported assertion | Upstream case |
| --- | --- |
| Inherits the parent options when the session has no request header | "inherits the parent effort while the exact route is unchanged" |
| Prefers the session request header over the frozen options | "inherits the latest logged request selection over creation-time values" |
| Carries maxTokens from the parent options regardless of the header | same case — the header config carries no maxTokens, and the expected output keeps the 512 from the creation options |
| Keeps explicit per-child overrides on top of the inherited route | "keeps an explicit child effort when the child route changes" |
| Resolves an empty child route when neither options nor header carry a model | **missing** |

## Decision

Add the missing empty-route case to the upstream spec. No code change: `resolveChildAgentOptions` already resolves `{ subagentDepth }` when the parent carries no route, and the new assertion pins that degenerate input instead of letting it silently regress into an undefined-provider child.

## Consequences

The ported assertion set is fully covered by the upstream spec plus the new case; the legacy branch remains available as read-only reference.