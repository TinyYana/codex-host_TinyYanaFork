# Remote Control 远程 Harness Host（实验）

通过 Codex Desktop 官方 Remote Control，在另一台电脑上使用只安装、只登录在被控 Windows 上的 Harness。不需要 SSH，不新增网络端口，Harness 凭据和项目文件始终留在 Windows 上。

## 前置条件

- 被控机器为 Windows；目前已验证的控制端为 macOS。
- 被控端不是 Windows 时，原生 Codex 任务仍可通过 Remote Control 使用，但 Harness 不可用，发往该 Host 的 Harness 请求会返回指明其为非 Windows 被控端的错误。要在 Mac 或 Linux 上使用 Harness，请改用 [SSH](remote-ssh-host.zh-CN.md)。
- 两台电脑安装相同版本的 codexhost，并都通过 codexhost 启动 Codex Desktop。
- 两端已登录 Remote Control 要求的 ChatGPT 账号，并完成官方配对。
- 目标 Harness 已在 Windows 上安装并登录。

## 连接步骤

1. 在 Windows 上打开 **设置 → 连接 → 控制此电脑**，启用访问并生成配对码。
2. 在控制端打开 **设置 → 连接 → 控制其他设备**，输入配对码并选择 Windows 环境。
3. 打开该环境中的项目，在输入框的 Agent / Model 选择器中选择目标 Harness。

## 常见问题

先确认原生 Codex 任务能通过 Remote Control 正常运行。配对失败、环境缺失、账号授权错误都属于官方 Remote Control，与 codexhost 无关。

- **`unknown variant codexhost/harness/inspect`**：升级并重启两端 codexhost，再重新连接 Remote Control 环境。
- **桥接启动失败或 `no active process for process handle`**：确认 Windows 上的 Codex Desktop 是通过 codexhost 启动的，重启被控端后重新连接环境。
- **Windows 重启后初始化超时**：直接重试刚才的操作。
- **`Host remote-control:… is a non-Windows controlled machine`**：被控端不是 Windows，其 Remote Control 中继无法启动 codexhost 桥接。原生 Codex 任务不受影响；要在该电脑上使用 Harness，请改用 [SSH](remote-ssh-host.zh-CN.md) 连接。
- **原生 Codex 可用但看不到 Harness**：在控制端运行连接诊断，再检查 Windows 上 Harness 的安装和登录状态。
- **`Claude inbound is disabled`**：Windows 上的 codexhost 关闭了 Claude Code 集成，启用后重试。
