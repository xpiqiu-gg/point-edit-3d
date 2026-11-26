<p align="center">
  <img src="plugins/point-edit-3d/assets/point-edit-3d-icon-v4.svg" alt="Point Edit 3D" width="112">
</p>

<h1 align="center">Point Edit 3D</h1>

<p align="center">v0.1.0</p>

<p align="center"><strong>指向三维场景，让 AI 知道你想改哪里。</strong></p>
<p align="center">在 Blender 或 Cinema 4D 场景中选择对象、留下批注，通过 Codex 进行分析和建模。</p>

---

Point Edit 3D 是连接 Codex 与三维软件的三维批注工具：把当前场景导出为网页中的可交互预览，你在预览里点选或框选对象、写下问题或修改要求，Codex 读取批注后分析，或直接修改原场景。目前支持 Blender 和 Cinema 4D。

<!-- 建议在这里放一张截图或 GIF，例如：![预览与批注](docs/preview.png) -->

## 功能

- **三维预览**：直接从运行中的 Blender / C4D 导出，无需在网页里打开工程文件。
- **点选、框选、三维框**：点选可累积和取消；二维框选记录命中对象与深度；三维框用三轴手柄移动和调整尺寸，可与点选同时保留。
- **询问与编辑**：询问批注用于分析，编辑批注用于描述想要的修改。
- **多条批注**：分别保存、编号，正文可引用其他批注。
- **可靠的对象对应**：Blender 使用物体 UID，C4D 使用稳定编号。编号失效时按名称、层级、类型和包围盒唯一复核，对不上就拒绝执行，不会静默改错对象。
- **恢复手段**：执行编辑前自动创建 `.blend` / `.c4d` 恢复副本；C4D 还会建立撤销组，可用 Ctrl+Z 回退。

## 快速开始

### 环境

- 支持本地插件的 Codex，Node.js 20 或更新版本。
- Blender 4.2 或更新版本（Blender 的 Python 需要 `requests`），或 Cinema 4D 2024 或更新版本。
- 已在 Windows、Blender 5.3、Cinema 4D 2026 上做过功能测试；其他环境请自行验证。

### 安装

1. 克隆本仓库，或在 GitHub 页面通过 Code → Download ZIP 下载源码压缩包并解压，然后在仓库根目录（包含 `plugins/` 文件夹的目录）打开 PowerShell：

   ```powershell
   codex plugin marketplace add .
   codex plugin add point-edit-3d@point-edit-3d-local
   ```

2. 安装三维软件一侧的插件：
   - **Blender**：偏好设置 → 从磁盘安装，选取 `plugins/point-edit-3d/blender/point_edit_3d.zip` 并启用。
   - **C4D**：把 `plugins/point-edit-3d/c4d_plugin/` 中的插件复制到 C4D 用户插件目录（也可让 Codex 运行 `point_edit_3d_c4d_setup` 并传 `install: true` 自动复制），然后**让插件开始监听**：启动 C4D 前设置环境变量 `C4D_MCP_AUTOSTART=1`，或在 C4D 插件菜单打开 **Socket Server Plugin** 并点击 **Start Server**。最后重启 C4D。无需另外启动 cinema4d-mcp 服务端。

3. 重新打开 Codex，在 Blender 3D 视图侧栏或 C4D 中检查连接状态。

详细步骤与故障排查见 [安装与使用](安装与使用.md)。请保留这个目录作为本地插件源，不要移动或删除。

### 使用

1. 打开 Blender 或 C4D 场景，在 Codex 中说“用 Point Edit 3D 打开当前 Blender 场景”或“连接 C4D”。
2. 在预览页面中点选或框选对象，选择“询问”或“编辑”，输入要求并保存批注。
3. 回到同一 Codex 对话说“继续”，Codex 会读取并处理批注。

## 使用前请知道

- 编辑批注会以对应软件的 Python 权限执行，目标编号只用于核验和指导 AI，**不是执行沙箱**。
- 执行前会在 `~/.point-edit-3d/backups` 创建恢复副本；执行失败仍可能留下部分修改，C4D 文档也不会被自动保存。
- 批注保存在本机 `~/.point-edit-3d/inbox`，分享该目录前请检查是否含有私人内容。

## 工作方式

```text
Blender 当前场景 ─┐
                  ├→ 内存 GLB / 内嵌 glTF → 网页预览与批注
C4D 场景副本 ─────┘                             ↓
Blender / C4D 原场景 ← Codex 分析 / Python 编辑 ← JSON 批注快照
```

预览是导出那一刻的快照，原场景之后的修改需要重新打开预览。Blender 的 GLB 通过本机连接在内存中传输（个别纹理处理可能产生短暂的临时图片）；C4D 的 glTF 写入临时目录供读取，读取后立即删除，不会覆盖原文件。批注 JSON 只保存选择与命中信息，不含完整三维模型。

## 已知限制

- 重启软件或更换文档后，需要重新打开预览并重新批注。
- C4D 预览：隐藏对象也会导出；空物体、摄像机、灯光等非网格对象无法点选；材质通过 glTF PBR 近似，复杂材质会在界面提示。
- 批注里的落点和三维框使用预览坐标（Y 轴向上），不能直接当作 C4D 世界坐标；批注会附带换算后的 C4D 坐标和 `exact` / `approx` 精度标记。
- 其他 Three.js 网站需要单独适配。

C4D 的场景身份、对象编号失效处理、坐标换算等细节见 [安装与使用](安装与使用.md)；构建与测试见 [开发说明](开发说明.md)。

## 致谢与声明

Blender 连接与建模桥接基于 [mcp-for-blender](https://github.com/ahujasid/mcp-for-blender) 开发，该项目采用 MIT 许可证，版权和许可说明保留在 `plugins/point-edit-3d/blender/point_edit_3d/LICENSE`。C4D 端使用随包的 [cinema4d-mcp](https://github.com/sdimaging/cinema4d-mcp) C4D 插件（MIT，见 `plugins/point-edit-3d/c4d_plugin/LICENSE`），只使用其本机 JSON 命令接口。其他第三方组件的许可证见 `third-party-licenses`。

本项目与 Blender Foundation、Maxon、OpenAI 无官方关联。

## 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE)；第三方组件遵循各自的许可条款。
