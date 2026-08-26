# Agent Note：Windows 上隐藏子进程控制台窗口

Status: implemented

[English](2026-08-27-subprocess-windows-console-window.md) | 中文

## 问题

在 Windows 上，从无控制台的宿主进程 spawn 控制台程序（pwsh、bash、git 等）时，每次 spawn 系统都会给子进程分配一个全新的可见控制台窗口。DSH web 服务器如果是在某个已经关闭的终端里启动的，就没有可继承的控制台，于是每次 `pwsh`/`bash` 工具调用都会在用户面前弹出 pwsh.exe 窗口。

Node 只有在传入 `windowsHide: true` 时才会设置 `CREATE_NO_WINDOW` 创建标志；`dsh-subprocess-local` 的 `spawnSubprocess` 与 `taskkillProcessTree` 此前都没有设置它。

## 决策

在 `spawnSubprocess` 的 `spawn` 与 `taskkillProcessTree` 的 `spawnSync` 上设置 `windowsHide: true`（`packages/subprocess/subprocess-local/src/spawn.ts`）。在 Windows 上它对应 `CREATE_NO_WINDOW` —— 子进程没有可见控制台，而 stdio 管道照常捕获输出；在 POSIX 上该选项被忽略，因此其它平台行为完全不变。

所有 subprocess 消费者（pwsh 与 bash 工具执行器）都经 `ctx.subprocess.spawn` 路由，所以一个调用点即可覆盖全部 spawn；`taskkill` 一并处理，是因为进程树清理同样会弹出窗口。

## 备选方案

**给 pwsh 传 `-WindowStyle Hidden`。** 否决：pwsh 7 不支持 `-WindowStyle`（只有 Windows PowerShell 5.1 支持），且无法覆盖 bash 或其它控制台子进程。

**启动时给服务器挂一个隐藏控制台。** 否决：这是部署形态问题，不随启动器变化而持久，且其它无控制台的宿主进程仍暴露于同样的弹窗。

## 影响

DSH 服务器 spawn 的控制台子进程不再闪现窗口，与服务器如何被启动无关。其余行为不变：stdio 采集、信号升级、进程树清理均未改动。

## 测试

`packages/subprocess/subprocess-local/tests/spawn-windows-hide.spec.ts` 对 `node:child_process.spawn` 打桩，固定 `spawnSubprocess` 传入 `windowsHide: true`。弹窗本身在受影响主机上做了运行验证（无控制台的 `dsh web` 服务器）：对已安装包施加同样的修改后，工具调用不再弹窗。
