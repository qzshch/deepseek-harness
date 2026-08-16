# Agent Note: 能力授权前先把私有临时目录的 DACL 自包含

Status: implemented

[English](2026-08-16-windows-acl-system-temp-dacl-lockout.md) | 中文

## Problem

在用户的 `TMP`/`TEMP` 解析到系统临时目录的 Windows 主机上（机器级 `TMP=TEMP=C:\Windows\Temp`，无用户级覆盖），每条沙箱命令都失败，报 `sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host`，runner 详情为 `windows-acl-run: --temp is not an existing directory: C:\WINDOWS\TEMP\dsh-XXXXXX`。

目录其实存在——seam 刚用 `mkdtempSync(join(tmpdir(), 'dsh-'))` 创建了它——但授权时的 `SetNamedSecurityInfoW` 重放让它对创建者不可见：刚创建该目录的用户对它的 `existsSync` 与 `accessSync` 全部返回 false，因此 runner 的 `requireDirectory('--temp', …)` 门槛（就是一个 `existsSync`）报出"目录不存在"。工具层按设计 fail-closed，把 runner 失败归类为 `SandboxUnavailableError`。

受影响机器上直接用发布包复现：`C:\WINDOWS\TEMP` 下新建的 `mkdtempSync` 子目录在 `AclWriteGrant.add` 之前完全可访问，之后被完全锁死（R/W/X 全 false，连 `icacls` 都被拒）。同样的代码路径在 `%LOCALAPPDATA%\Temp` 下无害——那里的私有目录继承 ACE 带有创建者完全控制授权，能够经受重放。

## Decision

可回收（私有临时）路径在**能力授权前先把 DACL 自包含**：`selfContainDacl`（`packages/sandbox/sandbox-windows-acl` 新增）读取目录当前 DACL，把每条 ACE 重新生成为显式条目——继承位（OI/CI/NP/IO）原样保留，去掉 `ACE_INHERITED` 标记——通过 `SetEntriesInAclW` 从零重建 ACL，再用 `SetNamedSecurityInfoW` 应用。不再有继承 ACE 后，授权自身的重放就无法因重新传播而丢失它们，创建者保留继承形状原本授予的访问。

两个授予私有临时目录的调用点都覆盖：

- `AclWriteGrant.add(path)` 的可回收路径（`sandbox-local` 的 `materializeAclGrant` 以 `standing: false` 调用它）；
- `AclSandbox.init()` 在 `manageDacls: true` 下（agentless runner 流程，它自己创建私有子目录）。

工作区根目录刻意**不**自包含：`add(path, standing: true)` 跳过它，`AclSandbox` 也绝不对 `writableDirs` 应用。它们的继承 ACE 与传播关系就是常驻复用缓存——物化会重写整棵树的 ACL 语义。

作为安全网，`grantWrite` 在真实应用后重新验证创建者访问（`accessSync(path, R_OK | W_OK)`），抛出真实原因，而不是让 runner 误报目录缺失。`ENOENT`（目录不存在——调用方 bug，不是锁死）留给调用方自己的错误处理。

## Alternatives considered

**在 `sandbox-local` 回退到用户自有的临时根**（当 `tmpdir()` 是系统目录时改用 `%LOCALAPPDATA%\Temp`）。作为主修复被否决：它只是转移失败而不是消除——任何未来继承形状缺少创建者授权的临时根（包括从不咨询 `sandbox-local` 的 agentless runner 路径）都会遇到同样的 ACL 重放风险。自包含修复让授权在**任何**临时根下都安全；回退仍是合理的运维层变通，并已按此记录。

**只做验证（只有 `accessSync` 检查，不做自包含）。** 被否决：它把误导性消息变成清晰消息，但受影响主机上的每条沙箱命令仍然失败。验证作为物化未能预见的形状的安全网保留下来。

**授权前给创建者加一条显式完全控制 ACE。** 实现更简单（多一次合并），但它重写了目录的访问语义——创建者获得继承形状未必授予的完全控制——而且不保留重放同样可能丢掉的其它继承 ACE（SYSTEM、Administrators、Everyone 读）。物化保留确切的生效 ACL。

**在 `mergeAndApply` 里无条件物化。** 这也会覆盖工作区根。被否决：在工作区根上剥离继承标记会改变其后代的继承内容，把常驻复用缓存变成一次性快照。

## Consequences

在受影响的主机形状下沙箱端到端可用：私有临时目录在授权后保留创建者访问，runner 的 `existsSync` 门槛通过，受限令牌子进程正常执行。私有临时目录的 DACL 此后不再跟随父目录 ACL——对只存活一个会话随即删除的目录无关紧要，而且比继承自不可预测的根更安全。

重放确实锁死创建者的目录上，`grantWrite` 现在抛出真实原因（点名临时根的继承 ACE 形状与 `TMP`/`TEMP` 补救措施），而不是 runner 误导性的 `--temp is not an existing directory`。

`AclWriteGrant` 与 `AclSandbox` 契约不变；新增的 `selfContainDacl` 导出是纯增量。

## Testing

`packages/sandbox/sandbox-windows-acl/tests/self-contain.spec.ts` 固定三个行为：`selfContainDacl` 把继承 ACE 重新生成为显式条目（DACL 出现无继承标记的条目）；`AclWriteGrant.add` 在系统临时形状的父目录下保持创建者可访问、能力 ACE 可见且可回收；——在真实系统临时根可写的主机上——其下的完整 `add` 流程在重放后保持创建者可访问（其它环境自行跳过）。受影响机器在本改动之前用发布包复现了锁死，改动后用源码在真实 `C:\WINDOWS\TEMP` 下通过修复路径。
