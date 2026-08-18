/* dsh-conflict-guardian — client bundle (web platform).
 *
 * Shows a frame-wide conflict report dialog after DSH opens when the startup
 * scan found plugin conflicts: which plugins conflicted, where (entry + file),
 * and what was done (auto-stopped / auto-restored / advisory).
 *
 * This is a pre-built bundle in the same form as dsh-omni-bridge and
 * dsh-session-mover (window.__ModuleLoader__.load + require('react')).
 * Host RPC goes through the webServer routes: POST /conflict-guardian/report
 * and POST /conflict-guardian/rescan (see lib/index.js).
 */
window.__ModuleLoader__.load({
  id: 'dsh-conflict-guardian',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');

    var CSS =
      '.dcg-backdrop{position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:8vh 16px 16px;background:rgba(0,0,0,.5);pointer-events:auto;font-family:system-ui,sans-serif}' +
      '.dcg-card{width:min(580px,100%);max-height:78vh;overflow:auto;background:var(--dsw-alias-bg-overlay,#f7f8fa);color:var(--dsw-alias-label-primary,#0f1115);border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.25));border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.4);padding:20px 22px;font-size:13px;line-height:1.6}' +
      '.dcg-title{margin:0 0 4px;font-size:16px;font-weight:700}' +
      '.dcg-sub{margin:0 0 14px;color:var(--dsw-alias-label-secondary,#61666b)}' +
      '.dcg-item{border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.18));border-left:3px solid var(--dsw-alias-state-warn-primary,#f5a623);border-radius:8px;padding:10px 12px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.6))}' +
      '.dcg-item.blocked{border-left-color:var(--dsw-alias-state-error-primary,#e5484d)}' +
      '.dcg-item-title{font-weight:600;margin-bottom:4px}' +
      '.dcg-detail{color:var(--dsw-alias-label-secondary,#61666b);margin-bottom:6px;word-break:break-word}' +
      '.dcg-action{color:var(--dsw-alias-label-primary,#0f1115)}' +
      '.dcg-chip{display:inline-block;background:var(--dsw-alias-bg-layer-1,#f4f4f5);border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.25));border-radius:999px;padding:1px 8px;margin:2px 4px 2px 0;font-family:ui-monospace,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}' +
      '.dcg-footer{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}' +
      '.dcg-btn{display:inline-flex;align-items:center;justify-content:center;min-height:34px;padding:6px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);border:1px solid var(--dsw-alias-label-secondary,#61666b);transition:background .15s ease,opacity .15s ease,box-shadow .15s ease}' +
      '.dcg-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1,#f4f4f5)}' +
      '.dcg-btn:active:not(:disabled){opacity:.8}' +
      '.dcg-btn:disabled{opacity:.55;cursor:default}' +
      '.dcg-btn.primary{background:var(--dsw-alias-brand-primary,#1f2937);color:var(--dsw-alias-label-primary-inverted,#fff);border-color:transparent;box-shadow:0 1px 2px rgba(0,0,0,.25)}' +
      '.dcg-btn.primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#1f2937);opacity:.9}';

    function h(type, props) {
      var args = [type, props];
      for (var i = 2; i < arguments.length; i += 1) args.push(arguments[i]);
      return React.createElement.apply(null, args);
    }

    function callHost(method) {
      return fetch('/conflict-guardian/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store'
      }).then(function (res) {
        return res.json();
      });
    }

    function ConflictGuardianDialog() {
      var reportState = React.useState(null);
      var report = reportState[0];
      var setReport = reportState[1];
      var dismissedState = React.useState(false);
      var dismissed = dismissedState[0];
      var setDismissed = dismissedState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      React.useEffect(function () {
        var cancelled = false;
        callHost('report').then(function (result) {
          if (!cancelled) setReport(result);
        }).catch(function () {});
        return function () { cancelled = true; };
      }, []);

      function rescan() {
        setBusy(true);
        callHost('rescan').then(function (result) {
          setReport(result);
          setDismissed(false);
        }).catch(function () {}).finally(function () { setBusy(false); });
      }

      if (dismissed) return null;
      var conflicts = report && Array.isArray(report.conflicts) ? report.conflicts : [];
      if (conflicts.length === 0) return null;

      var items = conflicts.map(function (conflict) {
        var chips = (conflict.where || []).map(function (p) {
          return h('span', { className: 'dcg-chip', key: conflict.id + '-' + (p.entryId || p.module) },
            String(p.module) + (p.file ? ' · ' + String(p.file) : ''));
        });
        return h('div', { className: 'dcg-item' + (conflict.severity === 'blocked' ? ' blocked' : ''), key: conflict.id },
          h('div', { className: 'dcg-item-title' }, String(conflict.title)),
          h('div', { className: 'dcg-detail' }, String(conflict.detail)),
          h('div', { className: 'dcg-action' }, '处理：' + String(conflict.action)),
          chips.length > 0 ? h('div', null, chips) : null);
      });

      return h('div', { className: 'dcg-backdrop', onClick: function () { setDismissed(true); } },
        h('div', { className: 'dcg-card', onClick: function (e) { e.stopPropagation(); } },
          h('h2', { className: 'dcg-title' }, 'DSH 插件冲突检测'),
          h('p', { className: 'dcg-sub' }, report ? String(report.summary || '') : ''),
          items,
          h('div', { className: 'dcg-footer' },
            h('button', { className: 'dcg-btn', onClick: rescan, disabled: busy }, busy ? '检测中…' : '重新检测'),
            h('button', { className: 'dcg-btn primary', onClick: function () { setDismissed(true); } }, '知道了'))));
    }

    var inject = ['slots'];

    function apply(ctx) {
      try {
        var style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);
      } catch (error) {}
      ctx.slots.register(
        { name: 'shell.overlay', id: 'dsh-conflict-guardian-dialog', order: 100, label: '插件冲突检测弹窗' },
        ConflictGuardianDialog
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'dsh-conflict-guardian';
    return module.exports;
  }
});
