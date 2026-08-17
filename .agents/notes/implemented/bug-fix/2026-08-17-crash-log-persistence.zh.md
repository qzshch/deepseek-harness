# Agent Note: 致命进程错误在退出前写入崩溃日志

Status: implemented

[English](2026-08-17-crash-log-persistence.md) | 中文

## Problem

一个长时间运行的 `dsh` 界面（web 服务器）在夜间静默死亡：次日早晨浏览器报"连接被拒绝"，但磁盘上没有任何内容解释原因。失败模式正是本包已经防护的进程级问题——致命的 `unhandledRejection` 会被 `installFailLoud` 转换为一行带标签的 stderr 消息并执行 `exit(1)`——然而这条诊断的持久性完全取决于启动 shell 是否捕获了 stderr。没有终端或重定向启动的界面（隐藏的 `Start-Process`、计划任务、bat 启动器）会完全丢失这行内容，留下一次长达 5 小时的服务中断：没有崩溃堆栈、没有 Windows 错误报告（干净退出不是原生崩溃）、会话日志尾部也没有记录（进程在下一个持久化检查点之前就死了）。`uncaughtException` 更糟：没有任何处理器，Node 的默认行为是打印到 stderr 后退出，同样不留任何记录。

## Decision

现在 `dsh` 各个界面上的每次致命进程错误都会在进程退出前写入 `$DSH_HOME/logs/crash.log`，与 stderr 是否被捕获无关：

- `createCrashLog(homeDir)`（`packages/boot/app-boot` 新增）返回一个尽力而为的同步接收器，把带时间戳的行追加到 `$homeDir/logs/crash.log`，首次写入时创建 `logs/` 目录。它绝不抛出异常：日志无法写入（磁盘已满、ACL）时不得掩盖被报告的错误。
- `installFailLoud` 新增可选第四参数 `log`；处理器在写入 stderr 和等待 `release` 之前，先把同一条诊断行同步交给该接收器，因此 release 钩子卡死也不会吞掉已记录的原因。
- `installUncaughtCrashLog`（新增）注册一个致命的 `uncaughtException` 处理器，在 `exit(1)` 之前把同一行带标签的诊断写入 stderr 和可选接收器，保留 Node 默认的 fail-closed 行为，同时让崩溃可恢复、可诊断。
- `apps/cli/src/profile-boot.ts` 用 `createCrashLog(resolveDshHome())` 把两者接入每个 `dsh` 界面。

fail-closed 行为不变：未处理的 rejection 与未捕获异常仍然以退出码 1 结束。本改动只让原因变得可持久记录。

## Alternatives considered

**改变长驻界面的失败模式**（记录 rejection 后继续运行而非退出）。被否决：这逆转了 `installFailLoud` 文档化并经测试的 fail-closed 契约，而且未处理的 rejection 可能意味着持久状态已损坏，继续运行会把损坏写盘。先做记录是保守的一步；重议退出策略是另一个独立决策，需要自己的 note。

**由每个 bin 自己写日志路径。** 被否决：接收器、目录创建以及"绝不抛出"契约应归属于它们所服务的 fail-loud 机制，这样每个界面（包括 `dsh-acp-demo`）都能从同一个所有者继承。

## Consequences

任何 `dsh` 界面的崩溃现在都会在 `~/.dsh/logs/crash.log` 留下首个致命 rejection 或未捕获异常的时间戳堆栈，因此下一次中断无需捕获 stderr 也能诊断。`installFailLoud` 的签名增加了一个可选参数；现有不传 `log` 的调用方行为完全不变。新增的 `uncaughtException` 处理器以退出码 1 结束，而 Node 默认同样以 1 结束，因此退出码契约没有变化。

## Testing

`packages/boot/app-boot/tests/app-boot.spec.ts` 覆盖：`createCrashLog` 在 `logs/` 下追加带时间戳的行（创建目录），目标被文件阻塞时也不抛出；`installFailLoud` 在写入 stderr 之前把诊断行交给接收器；`installUncaughtCrashLog` 写入带标签的堆栈、经接收器记录、以 1 退出、字符串化非 Error 值、无堆栈时回退到 message，且其卸载函数能移除处理器（包括真实 process 默认分支——立即卸载，使测试套件不泄漏处理器）。
