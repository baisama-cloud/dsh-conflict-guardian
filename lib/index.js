/**
 * dsh-conflict-guardian �?host half.
 *
 * On every DSH start (plugin activation) scans the live loader tree for plugin
 * conflicts and keeps the runtime stable:
 *
 *   R1 duplicate mount     �?the same module mounted with an IDENTICAL config
 *                            more than once (same module with different config
 *                            is a legitimate Cordis multi-instance pattern);
 *   R2 failed              �?a plugin whose fiber failed during activation
 *                            (the error text often names the collision, e.g.
 *                            "service X has been registered at �?);
 *   R3 pending             �?a plugin waiting forever on injected services that
 *                            no loaded plugin provides;
 *   R4 inactive            �?an enabled entry with no running fiber: restored
 *                            automatically (covers wrongly stopped instances);
 *   R5 duplicate row id    �?the same row id used twice inside one composition
 *                            file (advisory; would break the next boot).
 *
 * Conflicting plugins are stopped at runtime ONLY �?no configuration file is
 * ever rewritten �?and enabled-but-idle entries are restarted, so a restart
 * still loads the original composition and the scan runs again.
 *
 * The client half (lib/client.js) reaches the report through the
 * /conflict-guardian/�?routes registered below; when the same logic is adapted
 * into the dynamic plugin runner, the guarded harness.handle arms answer the
 * same methods (and register the model-callable `conflict_check` tool).
 */

export const name = 'dsh-conflict-guardian';
export const inject = [];

const FIBER_PENDING = 0;
const FIBER_ACTIVE = 2;
const FIBER_FAILED = 3;

let lastReport = null;

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function messageOf(error) {
  return (error && error.message) || String(error);
}

// ── conflict scan ────────────────────────────────────────────────────────────

/** Enumerate real plugin entries from the loader tree (containers skipped). */
function collectEntries(loader) {
  const out = [];
  if (!loader) return out;
  try {
    for (const entry of loader.entries()) {
      if (entry === null || typeof entry !== 'object') continue;
      const options = entry.options || {};
      if (options.group || entry.subtree || entry.subgroup) continue;
      const parentTree = entry.parent && entry.parent.tree;
      const fiber = entry.fiber || null;
      out.push({
        entry,
        fiber,
        entryId: String(options.id || ''),
        module: String(options.name || ''),
        disabled: Boolean(options.disabled),
        config: options.config !== undefined ? options.config : null,
        file: parentTree && parentTree.filename ? String(parentTree.filename) : '',
        fiberState: fiber ? fiber.state : null,
        active: Boolean(fiber && fiber.state === FIBER_ACTIVE)
      });
    }
  } catch (error) {
    console.error('[dsh-conflict-guardian] enumerate loader entries failed', error);
  }
  return out;
}

/** Collect every composition file's raw rows for the static scan. */
function collectFiles(loader) {
  const files = new Map();
  if (!loader) return files;
  try {
    for (const entry of loader.entries()) {
      const tree = entry.subtree;
      if (!tree || !tree.filename) continue;
      const filename = String(tree.filename);
      if (files.has(filename)) continue;
      let rows = [];
      try {
        const data = tree.root && tree.root.data;
        if (Array.isArray(data)) rows = data;
      } catch (_) {}
      files.set(filename, rows);
    }
  } catch (error) {
    console.error('[dsh-conflict-guardian] collect composition files failed', error);
  }
  return files;
}

/** Runtime-only stop: dispose the fiber, never touch any config file. */
async function stopEntry(rec) {
  if (!rec.entry || !rec.fiber) return 'skipped';
  try {
    await rec.entry._dispose();
    return 'stopped';
  } catch (error) {
    console.error('[dsh-conflict-guardian] failed to stop plugin ' + rec.module, error);
    return 'failed';
  }
}

function configSignature(config) {
  try {
    return JSON.stringify(config === undefined ? null : config);
  } catch (_) {
    return null;
  }
}

function location(rec) {
  return rec.file
    ? '（条目�? + rec.entryId + '”，文件 ' + rec.file + '�?
    : '（条目�? + rec.entryId + '”，运行时创建）';
}

function pluginView(rec, stopped) {
  return {
    module: rec.module,
    entryId: rec.entryId,
    file: rec.file || '(运行时创�?',
    active: rec.active,
    stopped: Boolean(stopped)
  };
}

async function runScan(ctx) {
  const conflicts = [];
  const handled = new Set();
  let counter = 0;
  const loader = ctx.get('loader');
  const entries = collectEntries(loader);

  // R1) duplicate mount: same module with an identical config, more than once
  const byModule = new Map();
  for (const rec of entries) {
    if (!rec.module || rec.disabled) continue;
    const list = byModule.get(rec.module) || [];
    list.push(rec);
    byModule.set(rec.module, list);
  }
  for (const [module, list] of byModule) {
    if (list.length < 2) continue;
    const byConfig = new Map();
    for (const rec of list) {
      const sig = configSignature(rec.config);
      const bucket = byConfig.get(sig) || [];
      bucket.push(rec);
      byConfig.set(sig, bucket);
    }
    for (const group of byConfig.values()) {
      if (group.length < 2) continue;
      counter += 1;
      const kept = group[0];
      let stoppedNow = 0;
      const views = [];
      for (const rec of group) {
        if (rec === kept) {
          views.push(pluginView(rec, false));
          continue;
        }
        handled.add(rec.entryId);
        let stopped = false;
        if (rec.fiber) {
          const result = await stopEntry(rec);
          stopped = result === 'stopped';
          if (stopped) stoppedNow += 1;
        }
        views.push(pluginView(rec, stopped || !rec.fiber));
      }
      conflicts.push({
        id: 'conflict-' + counter,
        kind: 'duplicate-mount',
        severity: stoppedNow > 0 ? 'blocked' : 'warning',
        title: '插件重复挂载�? + module,
        detail: '模块 ' + module + ' 在同一组合中被以完全相同的配置加载�?' + group.length + ' 次（'
          + group.map((r) => '条目�? + r.entryId + '�?).join('�?) + '）。完全相同的实例会重复注册服务、互相覆盖，导致行为不可预测�?,
        where: views,
        action: stoppedNow > 0
          ? '已自动停用后加载�?' + stoppedNow + ' 份实例，仅保留第一份（条目�? + kept.entryId + '”）'
          : '冲突实例此前已被停用，本次无需重复处理'
      });
    }
  }

  // R2) failed fibers: activation threw (often a service/tool registration clash)
  for (const rec of entries) {
    if (rec.disabled || !rec.fiber || rec.fiberState !== FIBER_FAILED) continue;
    counter += 1;
    let reason = '';
    try {
      await rec.fiber.await();
    } catch (error) {
      reason = error instanceof Error ? (error.message || '') : String(error);
    }
    handled.add(rec.entryId);
    const result = await stopEntry(rec);
    conflicts.push({
      id: 'conflict-' + counter,
      kind: 'failed',
      severity: 'blocked',
      title: '插件启动失败�? + rec.module,
      detail: '插件 ' + rec.module + ' ' + location(rec) + ' 激活时抛出错误，未正常运行�?
        + (reason ? '失败原因�? + reason : ''),
      where: [pluginView(rec, result === 'stopped')],
      action: result === 'stopped' ? '已自动停用该插件，避免其影响 DSH 稳定�? : '该插件已处于停止状�?
    });
  }

  // R3) pending fibers: waiting for injected services nobody provides
  for (const rec of entries) {
    if (rec.disabled || !rec.fiber || rec.fiberState !== FIBER_PENDING) continue;
    counter += 1;
    let missing = [];
    try {
      const inject = rec.fiber.inject || {};
      missing = Object.keys(inject).filter((n) => rec.fiber.ctx.get(n) === undefined);
    } catch (_) {}
    handled.add(rec.entryId);
    const result = await stopEntry(rec);
    conflicts.push({
      id: 'conflict-' + counter,
      kind: 'pending',
      severity: 'blocked',
      title: '插件依赖缺失�? + rec.module,
      detail: '插件 ' + rec.module + ' ' + location(rec) + ' 正在等待注入的服务，但没有任何已加载插件提供'
        + (missing.length ? '�? + missing.join('�?) : '') + '。依赖链断裂会使该插件永远无法激活�?,
      where: [pluginView(rec, result === 'stopped')],
      action: result === 'stopped' ? '已自动停用该插件，解除其挂起状�? : '该插件已处于停止状�?
    });
  }

  // R4) enabled entries with no running fiber: try to restore them
  for (const rec of entries) {
    if (rec.disabled || rec.fiber || handled.has(rec.entryId)) continue;
    counter += 1;
    let restored = false;
    let reason = '';
    try {
      if (rec.entry && typeof rec.entry.refresh === 'function') {
        await rec.entry.refresh();
        const check = rec.entry.fiber;
        restored = Boolean(check && check.state === FIBER_ACTIVE);
        if (!restored && check && check.state === FIBER_FAILED) {
          try {
            await check.await();
          } catch (e) {
            reason = e instanceof Error ? (e.message || '') : String(e);
          }
        }
      }
    } catch (error) {
      reason = error instanceof Error ? (error.message || '') : String(error);
    }
    conflicts.push({
      id: 'conflict-' + counter,
      kind: restored ? 'restored' : 'inactive',
      severity: restored ? 'warning' : 'blocked',
      title: (restored ? '插件已恢复：' : '插件未运行：') + rec.module,
      detail: '插件 ' + rec.module + ' ' + location(rec) + ' 处于启用状态但没有运行实例'
        + (restored ? '，已自动尝试重新启动并成功恢复�? : (reason ? '，自动恢复失败。原因：' + reason : '，自动恢复失败�?)),
      where: [pluginView(rec, !restored)],
      action: restored ? '已自动恢复该插件实例，无需手动干预' : '该插件无法启动，已保持停用状态；请检查其配置或依�?
    });
  }

  // R5) duplicate row ids inside one composition file (advisory)
  for (const [filename, rows] of collectFiles(loader)) {
    const idCount = new Map();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !row.id) continue;
      const id = String(row.id);
      idCount.set(id, (idCount.get(id) || 0) + 1);
    }
    for (const [id, count] of idCount) {
      if (count < 2) continue;
      counter += 1;
      conflicts.push({
        id: 'conflict-' + counter,
        kind: 'duplicate-row-id',
        severity: 'warning',
        title: '组合配置�?id 重复�? + id,
        detail: '配置文件 ' + filename + ' 中有 ' + count + ' 行使用了同一�?id �? + id
          + '”。重复的 id 会让加载器在下次启动时直接抛错（duplicate loader entry id），导致 DSH 无法启动�?,
        where: [],
        action: '请手动修改配置文件，为其中一行指定唯一�?id（本插件不会修改你的配置文件�?
      });
    }
  }

  const blocked = conflicts.filter((c) => c.severity === 'blocked').length;
  const warnings = conflicts.length - blocked;
  let summary;
  if (conflicts.length === 0) {
    summary = '未检测到插件冲突，DSH 组合运行正常';
  } else if (blocked > 0 && warnings > 0) {
    summary = '检测到 ' + blocked + ' 个插件冲突（已自动处理）+ ' + warnings + ' 个提�?;
  } else if (blocked > 0) {
    summary = '检测到 ' + blocked + ' 个插件冲突，冲突插件已被自动处理，DSH 保持稳定运行';
  } else {
    summary = '检测到 ' + warnings + ' 个提示，不影响本次运�?;
  }
  return { ok: conflicts.length === 0, scannedAt: Date.now(), summary, conflicts };
}

// ── host entry ───────────────────────────────────────────────────────────────

