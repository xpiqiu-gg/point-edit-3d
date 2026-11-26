# C4D 桥接插件（随 Point Edit 3D 分发）

本目录是 [cinema4d-mcp](https://github.com/sdimaging/cinema4d-mcp) 的 C4D 端 socket 插件。Point Edit 3D
通过它在 `127.0.0.1:5555` 读取当前 C4D 文档、导出预览并执行批注修改；**不需要**另外启动
cinema4d-mcp 的 MCP 服务端。

| 文件 | 作用 |
| --- | --- |
| `mcp_server_plugin.pyp` | C4D 插件，由 C4D 加载后提供本机 TCP JSON 命令服务 |
| `scene_nodes_patterns.py` | 插件的 Scene Nodes 模式库（可选；缺失时只有 Scene Nodes 相关命令不可用） |
| `LICENSE` | 上游 MIT 许可证 |

## 安装

**方式一（推荐）**：在 Codex 中让 Point Edit 3D 运行 `point_edit_3d_c4d_setup`，并传入 `install: true`。
它会检测 C4D 用户插件目录、备份同名旧文件、复制本目录的插件，然后需要**重启 C4D**。

**方式二（手动）**：把 `mcp_server_plugin.pyp` 和 `scene_nodes_patterns.py` 复制到

- Windows：`%APPDATA%\Maxon\Cinema4D_<实例哈希>\plugins\`
- macOS：`~/Library/Preferences/Maxon/Cinema4D_<实例哈希>/plugins/`

然后重启 Cinema 4D。

## 说明与限制

- 本插件来自上游项目，按 MIT 许可证随包分发；版权与许可全文见 `LICENSE`。
- 插件会执行收到的 Python 代码，仅限本机使用，不要暴露到网络。
- 端口固定为本机回环地址；如插件侧改端口，需要在 Point Edit 3D 一侧设置
  `POINT_EDIT_3D_C4D_PORT` 为同一端口。
- C4D 2024+（本项目在 C4D 2026.0 上验证）。插件文件由 C4D 启动时加载，替换后必须重启 C4D。
- 这是上游组件的副本，Point Edit 3D 不修改其行为；上游升级时可用新文件替换本目录。
