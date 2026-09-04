// dsh-external-session - web client half.
// The directory browser below is a self-contained copy of the DSH browse-flow
// interaction pattern. It deliberately uses the public browse-capable workspace
// service instead of the native-only pickDirectory() method.
window.__ModuleLoader__.load({
  id: "dsh-external-session",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const Modal = primitives.Modal;
    const Button = primitives.Button;
    const IconFolderOpen16 = primitives.IconFolderOpen16;
    const IconFolderClose16 = primitives.IconFolderClose16;
    const IconChevronRightOutline14 = primitives.IconChevronRightOutline14;
    const IconEditOutline16 = primitives.IconEditOutline16;

    const CSS = [
      ".des-ext-badge{display:inline-flex!important;flex:0 0 auto!important;align-items:center;justify-content:center;box-sizing:border-box;min-width:72px;height:28px;padding:0 13px;border-radius:8px;font-size:13px;line-height:22px;font-weight:700;letter-spacing:.03em;color:#087237;background:rgba(16,163,74,.18);border:1px solid rgba(16,163,74,.55);white-space:nowrap;cursor:default}",
      ".des-ext-settings-action{display:inline-flex;align-items:center;box-sizing:border-box;flex:none}",
      ".des-ext-import-btn{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:auto;min-height:30px;padding:5px 10px;border-radius:7px;font-size:12px;line-height:18px;font-weight:550;color:#16834b;background:rgba(16,163,74,.08);border:1px solid rgba(16,163,74,.3);cursor:pointer;transition:background .15s ease,border-color .15s ease}",
      ".des-ext-import-btn:hover{background:rgba(16,163,74,.16);border-color:rgba(16,163,74,.5)}",
      ".des-ext-import-btn:disabled{opacity:.5;cursor:default}",
      ".des-ext-browser{display:flex;flex-direction:column;gap:0;width:min(680px,100%);height:min(500px,100dvh - 32px);padding:0;overflow:hidden}",
      ".des-ext-browser-head{display:flex;flex-direction:column;gap:8px;flex:none;padding:16px 20px 10px;border-bottom:1px solid var(--dsw-alias-border-l3)}",
      ".des-ext-browser-title{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:510;line-height:24px}",
      ".des-ext-browser-crumb-bar{display:flex;align-items:center;gap:4px;min-width:0;min-height:26px;padding:1px 4px;border:1px solid transparent;border-radius:7px;box-sizing:border-box}",
      ".des-ext-browser-crumb-bar:focus-within{border-color:var(--dsw-alias-border-l2)}",
      ".des-ext-browser-crumbs{display:flex;align-items:center;gap:3px;min-width:0;flex:1;overflow-x:auto;white-space:nowrap}",
      ".des-ext-browser-crumb-edit{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:22px;padding:0;border:0;border-radius:5px;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer}",
      ".des-ext-browser-crumb-edit:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".des-ext-browser-crumb-edit:disabled{color:var(--dsw-alias-label-caption);cursor:default;background:none}",
      ".des-ext-browser-path-input{display:block;box-sizing:border-box;flex:1;min-width:0;height:22px;padding:0 4px;border:0;outline:none;background:none;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}",
      ".des-ext-browser-crumb{max-width:180px;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary);background:none;border:0;padding:2px 4px;cursor:pointer;font-size:13px;font-weight:500}",
      ".des-ext-browser-crumb:hover{color:var(--dsw-alias-label-primary)}",
      ".des-ext-browser-content{position:relative;display:flex;flex:1;min-height:0;padding:16px 20px;overflow:auto}",
      ".des-ext-browser-list{display:flex;flex-direction:column;gap:2px;min-width:100%;overflow:auto}",
      ".des-ext-browser-row{display:flex;align-items:center;gap:5px;width:100%;height:30px;box-sizing:border-box;border:0;border-radius:6px;padding:5px 7px;text-align:left;background:none;color:var(--dsw-alias-label-primary);cursor:pointer}",
      ".des-ext-browser-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".des-ext-browser-row[aria-current=true]{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}",
      ".des-ext-browser-row-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px}",
      ".des-ext-browser-muted,.des-ext-browser-error{padding:4px;font-size:12px;line-height:18px}.des-ext-browser-muted{color:var(--dsw-alias-label-secondary)}.des-ext-browser-error{color:var(--dsw-alias-state-error-primary)}",
      ".des-ext-browser-footer{display:flex;align-items:center;gap:8px;flex:none;padding:14px 20px;border-top:1px solid var(--dsw-alias-border-l3)}",
      ".des-ext-browser-spacer{flex:1}.des-ext-browser-toggle{border:0;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px}.des-ext-browser-toggle:hover{color:var(--dsw-alias-label-primary)}",
    ].join("");

    const inject = ["slots", "workspaces", "sessions"];

    function pathName(path) {
      const clean = String(path || "").replace(/[\\\\/]+$/, "");
      const parts = clean.split(/[\\\\/]/);
      return parts[parts.length - 1] || clean || "主目录";
    }

    function DirectoryBrowser({ open, workspaces, onPicked, onCancel }) {
      const [listing, setListing] = React.useState(null);
      const [selected, setSelected] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [showHidden, setShowHidden] = React.useState(false);
      const [pathDraft, setPathDraft] = React.useState(null);
      const [history, setHistory] = React.useState([]);

      const load = React.useCallback((path, push) => {
        setLoading(true);
        setError(null);
        workspaces.listDirectory(path).then((next) => {
          if (push && listing?.path) setHistory((old) => old.concat([listing]));
          setListing(next);
          setSelected(null);
          setPathDraft(null);
          setLoading(false);
        }, (reason) => {
          setLoading(false);
          setError(reason?.message || String(reason));
        });
      }, [workspaces, listing]);

      React.useEffect(() => {
        if (!open) {
          setListing(null);
          setSelected(null);
          setHistory([]);
          setError(null);
          setPathDraft(null);
          return;
        }
        load(undefined, false);
      }, [open]);

      const visible = listing && Array.isArray(listing.entries)
        ? listing.entries.filter((entry) => showHidden || !entry.hidden)
        : [];
      const crumbs = listing && Array.isArray(listing.crumbs) ? listing.crumbs : [];
      const target = selected?.path || listing?.path || null;

      const beginPathEdit = () => {
        if (listing === null || loading) return;
        const base = selected?.path || listing.path || "";
        const separator = base.indexOf("\\") >= 0 ? "\\" : "/";
        const hasSeparator = base.endsWith("\\") || base.endsWith("/");
        setError(null);
        setPathDraft(base && !hasSeparator ? base + separator : base);
      };

      const submitPath = () => {
        const path = pathDraft === null ? "" : pathDraft.trim();
        if (!path || loading) return;
        setLoading(true);
        setError(null);
        workspaces.listDirectory(path).then((next) => {
          setListing(next);
          setSelected(null);
          setHistory([]);
          setPathDraft(null);
          setLoading(false);
        }, (reason) => {
          setLoading(false);
          setError(reason?.message || String(reason));
        });
      };

      return React.createElement(Modal, {
        open,
        onClose: onCancel,
        title: "选择项目目录",
        className: "des-ext-browser",
        headless: true,
      }, React.createElement(React.Fragment, null,
        React.createElement("div", { className: "des-ext-browser-head" },
          React.createElement("h2", { className: "des-ext-browser-title" }, "选择项目目录"),
          React.createElement("div", { className: "des-ext-browser-crumb-bar" },
            pathDraft !== null
              ? React.createElement("input", {
                className: "des-ext-browser-path-input",
                type: "text",
                value: pathDraft,
                autoFocus: true,
                "aria-label": "编辑路径",
                placeholder: "输入文件夹路径后按 Enter",
                disabled: loading,
                onChange: (event) => {
                  setPathDraft(event.target.value);
                  setError(null);
                },
                onKeyDown: (event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setPathDraft(null);
                    setError(null);
                  } else if (event.key === "Enter" && !event.isComposing) {
                    event.preventDefault();
                    submitPath();
                  }
                },
              })
              : React.createElement(React.Fragment, null,
                React.createElement("div", { className: "des-ext-browser-crumbs", role: "navigation" },
                  crumbs.map((crumb, index) => React.createElement(React.Fragment, { key: crumb.path },
                    index > 0 ? React.createElement(IconChevronRightOutline14, { size: 12 }) : null,
                    React.createElement("button", {
                      type: "button",
                      className: "des-ext-browser-crumb",
                      disabled: loading,
                      onClick: () => load(crumb.path, false),
                    }, crumb.name || pathName(crumb.path))
                  ))
                ),
                React.createElement("button", {
                  type: "button",
                  className: "des-ext-browser-crumb-edit",
                  "aria-label": "编辑路径",
                  title: "编辑路径",
                  disabled: listing === null || loading,
                  onClick: beginPathEdit,
                }, React.createElement(IconEditOutline16, { size: 14 }))
              )
          )
        ),
        React.createElement("div", { className: "des-ext-browser-content" },
          loading && !listing ? React.createElement("div", { className: "des-ext-browser-muted" }, "加载中…") : null,
          !loading && error ? React.createElement("div", { className: "des-ext-browser-error" }, error) : null,
          !error && listing ? React.createElement("div", { className: "des-ext-browser-list", role: "list" },
            visible.length === 0
              ? React.createElement("div", { className: "des-ext-browser-muted" }, "没有可显示的文件夹")
              : visible.map((entry) => {
                const isSelected = selected?.path === entry.path;
                return React.createElement("button", {
                  key: entry.path,
                  type: "button",
                  role: "listitem",
                  className: "des-ext-browser-row",
                  "aria-current": isSelected || undefined,
                  disabled: loading,
                  onClick: () => setSelected(entry),
                  onDoubleClick: () => load(entry.path, true),
                },
                  React.createElement(isSelected ? IconFolderOpen16 : IconFolderClose16, { size: 16 }),
                  React.createElement("span", { className: "des-ext-browser-row-name" }, entry.name),
                  React.createElement(IconChevronRightOutline14, { size: 12 })
                );
              })
          ) : null
        ),
        React.createElement("div", { className: "des-ext-browser-footer" },
          React.createElement("button", {
            type: "button",
            className: "des-ext-browser-toggle",
            "aria-pressed": showHidden,
            onClick: () => setShowHidden((value) => !value),
          }, showHidden ? "隐藏隐藏文件" : "显示隐藏文件"),
          React.createElement("div", { className: "des-ext-browser-spacer" }),
          history.length > 0 ? React.createElement(Button, {
            onClick: () => {
              const previous = history[history.length - 1];
              setHistory((old) => old.slice(0, -1));
              setListing(previous);
              setSelected(null);
              setError(null);
            },
          }, "返回") : null,
          React.createElement(Button, { variant: "outline", onClick: onCancel }, "取消"),
          React.createElement(Button, {
            variant: "primary",
            disabled: target === null || loading,
            onClick: () => { if (target !== null) onPicked(target); },
          }, "打开")
        )
      ));
    }

    function ImportExternalAction({ workspacesService, sessionsService }) {
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const importProject = async (path) => {
        setBusy(true);
        setError(null);
        try {
          const response = await fetch("/external-session/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
          const workspace = await workspacesService.create({ path });
          const sessionsResponse = await fetch("/external-session/sessions?entryId=" + encodeURIComponent(data.entry.id), {
            cache: "no-store",
          });
          const sessionsData = await sessionsResponse.json().catch(() => ({}));
          if (!sessionsResponse.ok) throw new Error(sessionsData.error || ("HTTP " + sessionsResponse.status));
          const existing = Array.isArray(sessionsData.items) ? sessionsData.items[0] : null;
          setOpen(false);
          if (existing?.id) {
            sessionsService.open(existing.id);
          } else {
            workspacesService.startSession(workspace.workspaceId);
          }
        } catch (reason) {
          setError(reason?.message || String(reason));
        } finally {
          setBusy(false);
        }
      };
      return React.createElement("div", { className: "des-ext-settings-action" },
        React.createElement("button", {
          type: "button",
          className: "des-ext-import-btn",
          title: "导入外部项目",
          "aria-label": "导入外部项目",
          onClick: () => { setError(null); setOpen(true); },
          disabled: busy,
        }, busy ? "导入中…" : "导入外部项目"),
        error ? React.createElement("div", { className: "des-ext-browser-error" }, "导入失败：" + error) : null,
        React.createElement(DirectoryBrowser, {
          open,
          workspaces: workspacesService,
          onPicked: importProject,
          onCancel: () => setOpen(false),
        })
      );
    }

    function ExternalBadge({ sessionId }) {
      const [external, setExternal] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        setExternal(false);
        if (!sessionId) return () => { alive = false; };
        const url = "/external-session/external?sessionId=" + encodeURIComponent(sessionId) + "&t=" + Date.now();
        fetch(url, { cache: "no-store" })
          .then((response) => response.ok ? response.json() : null)
          .then((data) => { if (alive) setExternal(data?.external === true); })
          .catch(() => { if (alive) setExternal(false); });
        return () => { alive = false; };
      }, [sessionId]);
      if (!external) return null;
      return React.createElement("span", {
        className: "des-ext-badge",
        "data-dsh-external-session-badge": sessionId,
        title: "外部存储会话（位于项目 .dsh-sessions，随 git 同步）",
      }, "外部");
    }

    function apply(ctx) {
      if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css='dsh-external-session']")) {
        const tag = document.createElement("style");
        tag.dataset.pluginCss = "dsh-external-session";
        tag.textContent = CSS;
        document.head.appendChild(tag);
        ctx.effect(() => () => tag.remove());
      }
      const slots = ctx.get("slots");
      if (!slots) return;
      slots.inject("settings.action", () => slots.register({
        name: "settings.action",
        id: "dsh-external-session-import",
        order: 20,
        inject: () => ({ workspacesService: ctx.workspaces, sessionsService: ctx.sessions }),
      }, ImportExternalAction));
      slots.inject("conversation.session.header.actions", () => slots.register({
        name: "conversation.session.header.actions",
        id: "dsh-external-session-badge",
        order: -9,
        inject: () => ({}),
      }, ExternalBadge));
    }

    exports.DirectoryBrowser = DirectoryBrowser;
    exports.ImportExternalAction = ImportExternalAction;
    exports.ExternalBadge = ExternalBadge;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
