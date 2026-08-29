# Agent Note: 子 Agent 选项继承覆盖——移植空 route 断言

Status: implemented

[English](2026-08-25-subagent-child-options-inherit-coverage.md) | 中文

## 问题

本地合并前分支 `fix/subagent-inherit-parent-route`（提交 `426f8699ba`，"继承父会话最新 request/header 的 provider/model"）已被上游取代：`parentAgentOptionsForDelegation()` 如今在 `child-agent.ts` 中拥有 header 优先于 options 的瀑布，本地代码已废弃。其针对 `resolveChildAgentOptions` 的 5 条 spec 断言已对照上游实现逐条检查，确认新基线 spec（`tests/child-agent.spec.ts`）还缺哪些场景。

覆盖映射：

| 移植断言 | 上游用例 |
| --- | --- |
| 会话无 request header 时继承父 options | "exact route 不变时继承父 effort" |
| 会话 request header 优先于冻结的 options | "creation 值之上继承最新记录的请求选择" |
| 无论 header 如何都从父 options 携带 maxTokens | 同上一用例——header config 不携带 maxTokens，期望输出保留 creation options 的 512 |
| 显式逐子 override 置于继承 route 之上 | "子 route 变化时保留显式子 effort" |
| options 与 header 都无 model 时解析出空子 route | **缺失** |

## 决策

向上游 spec 补入缺失的空 route 用例。无代码改动：`resolveChildAgentOptions` 在父无 route 时已解析为 `{ subagentDepth }`，新断言把这一退化输入钉住，防止其无声退化为 provider 未定义的子 agent。

## 后果

移植的断言集由上游 spec 加新用例完整覆盖；legacy 分支保留为只读参考。