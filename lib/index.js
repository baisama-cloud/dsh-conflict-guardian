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

