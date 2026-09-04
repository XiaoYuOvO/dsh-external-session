# dsh-external-session

Portable Git-backed external session persistence for DeepSeek Harness (DSH).

Sessions created under configured project roots are stored in `.dsh-sessions/` using clone-path-independent relative directory keys. The plugin reads legacy absolute-path layouts and remaps them when a repository is cloned elsewhere.

## Install from GitHub

```powershell
dsh plugin --profile web add github:XiaoYuOvO/dsh-external-session
```

After installation, configure the project root in the profile `cordis.patch.yml`; see [README.zh.md](README.zh.md) for configuration, migration behavior, safety rules, and tests.

## Development

```powershell
node test/run-tests.mjs
node test/web-routes.mjs
node test/fork-inherit.mjs
```

Released under the MIT license.
