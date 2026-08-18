# dsh-conflict-guardian
 
在 DeepSeek Harness（DSH）**每次启动时检测插件冲突**、自动停用或恢复冲突插件，并在 Web 界面弹出冲突报告，保证 DSH 稳定运行的插件。

插件激活（即每次 DSH 启动）即扫描一次加载器（loader）中的插件树，发现冲突立即处理，处理结果通过弹窗汇报——哪些插件冲突、在哪里冲突、做了什么处理。

## 功能

- **重复挂载检测**：同一模块以**完全相同配置**挂载多次视为真正重复，自动停用后加载的实例、保留第一份；同一模块不同配置（如 `tool-subagent` 的 spawn/fork 双实例）是合法的 Cordis 多实例模式，**不会**误判；
- **启动失败检测**：激活时抛出错误的插件（fiber 处于 failed，错误信息常直接指明冲突，如 `service X has been registered at …`），自动停用并报告失败原因；
- **依赖缺失检测**：因等待无人提供的注入服务而永远无法激活的插件（fiber 挂起），自动停用并列出缺失的服务名；
- **自动恢复**：启用但没有运行实例的条目会自动尝试重新启动（覆盖误停、加载失败等场景），恢复成功会明确提示；
- **配置行 id 重复**：静态扫描组合文件，发现同一文件内行 id 重复会给出警告（下次启动会导致加载器直接抛错），但**不会修改你的配置文件**；
- **界面弹窗**：检测到冲突后，页面打开时自动弹出报告，逐条显示冲突详情与处理结果，可「重新检测」或「知道了」关闭。

> 所有停用/恢复都是**运行时**操作，不修改任何 `cordis.yml`——重启后仍按原配置加载，扫描会再次运行，正好符合「每次启动都判断、有冲突就关停」的设计。

## 安装

与 DSH 插件包相同的分发方式（参考 `dsh-session-mover` / `dsh-omni-bridge`）：

```bash
# 克隆到本地后，用 dsh 的 bundle patch 机制挂载
npm pack            # 生成 dsh-conflict-guardian-0.1.0.tgz
```

或在 DSH 配置的插件列表中加入该包，`cordis.patch.yml` 已声明：

```yaml
- insert:
    - id: dsh-conflict-guardian
      name: 'dsh-conflict-guardian'
```

`lib/client.js` 是已打包的浏览器 bundle（`window.__ModuleLoader__.load` 形态，与 `dsh-omni-bridge` 相同）；宿主 `lib/index.js` 在 `webServer` 上注册 `POST /conflict-guardian/report` 与 `/conflict-guardian/rescan` 路由供客户端调用。若作为**动态插件**运行，宿主同样提供 `harness.handle('conflict-report' / 'conflict-rescan')` 配对，并额外注册模型可调用的 `conflict_check` 工具（两种方式都已内置，逻辑共用）。

## 使用

1. 安装并挂载后，每次 DSH 启动时插件自动扫描加载器；
2. 发现冲突立即自动处理（停用冲突实例 / 恢复未运行实例），并生成报告；
3. 打开 DSH 页面时，若有冲突即弹出报告弹窗：标题、摘要、每条冲突的**位置**（插件模块 + 组合条目 + 配置文件）与**处理结果**；
4. 也可随时点「重新检测」获取最新状态；模型可通过 `conflict_check` 工具随时检查。

## 工作原理

- 通过 `ctx.get('loader')` 枚举加载器树中的真实插件条目（跳过 group/include 容器），读取每个条目的模块名、配置、启用状态与 fiber 状态（pending / active / failed）；
- **R1 重复挂载**：按「模块名 + 配置签名（JSON）」分组，同组多于一份即真重复 → `entry._dispose()` 停用后加载实例（运行时停用，不写配置）；
- **R2 / R3 失败与挂起**：failed 的 fiber 先 `await()` 取回原始错误；pending 的 fiber 列出 `fiber.inject` 中无人提供的服务名 → 停用；
- **R4 自动恢复**：启用但无 fiber 的条目调用 `entry.refresh()` 重新启动，按恢复后 fiber 是否 active 判定成功与否；
- **R5 行 id 重复**：读取每个组合文件（Include 树）的原始行，统计行 id 出现次数；
- 报告通过 webServer 路由（静态安装）或 `harness.handle`（动态插件）提供给客户端弹窗。

## 限制

- 停用/恢复不持久化：重启后按原配置加载并再次检测（符合设计）；如需**永久**禁用某个冲突插件，请在组合文件中为该行设置 `disabled: true` 或删除多余行；
- 冲突检测基于加载器运行时状态与组合文件静态分析，不解析插件源码内的服务注册（无法预判尚未加载时的服务冲突）；
- 模型工具 `conflict_check` 仅在动态插件运行方式下注册（静态安装不引入额外依赖）。

## 许可

[MIT](./LICENSE)
