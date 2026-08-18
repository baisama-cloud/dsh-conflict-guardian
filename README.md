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

