---
summary: "Test packaged plugin overrides with setup-time install flows"
read_when:
  - Testing onboarding or setup flows against a locally packed plugin
  - Verifying a plugin package before publishing it
  - Replacing an automatic plugin install with a test artifact
title: "Plugin install overrides"
sidebarTitle: "Install overrides"
---

Plugin install overrides let maintainers point setup-time plugin installs at
a specific npm package or local npm-pack tarball instead of the catalog,
bundled, or default npm source. They exist for E2E and package validation
only; normal users install plugins with
[`openclaw plugins install`](/cli/plugins).

<Warning>
Overrides execute plugin code from the source you provide. Use them only in an
isolated state directory or disposable test machine.
</Warning>

## Environment

Overrides are disabled unless both variables are set:

```bash
export OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES=1
export OPENCLAW_PLUGIN_INSTALL_OVERRIDES='{
  "codex": "npm-pack:/tmp/openclaw-codex-2026.5.8.tgz",
  "openclaw-web-search": "npm:@openclaw/web-search@2026.5.8"
}'
```

The override map is JSON keyed by plugin id. Values support:

| Prefix                | Source                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `npm:<registry-spec>` | Registry packages, exact versions, or tags                                                       |
| `npm-pack:<path.tgz>` | Local tarballs produced by `npm pack`; relative paths resolve from the current working directory |

## Behavior

When a setup-time flow installs a plugin whose id appears in the map, OpenClaw
uses the override source instead of the catalog, bundled, or default npm
source. This applies to onboarding and any other flow using the shared
setup-time plugin installer.

- Overrides still enforce the expected plugin id: a tarball mapped to `codex`
  must install a plugin whose manifest id is `codex`.
- Overrides do not inherit official trusted-source status. Even when the
  catalog entry normally represents an OpenClaw-owned package, an override is
  treated as operator-supplied test input.
- Workspace `.env` files cannot enable install overrides; both env vars are on
  the blocked workspace dotenv list. Set them in the trusted shell, CI job, or
  remote test command that launches OpenClaw.

## Package E2E

Use an isolated state directory so package installs and install records do not
touch your normal OpenClaw state:

```bash
npm pack extensions/codex --pack-destination /tmp

OPENCLAW_STATE_DIR="$(mktemp -d)" \
OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES=1 \
OPENCLAW_PLUGIN_INSTALL_OVERRIDES='{"codex":"npm-pack:/tmp/openclaw-codex-2026.5.8.tgz"}' \
pnpm openclaw onboard --mode local
```

Verify the installed package under the state directory:

```bash
find "$OPENCLAW_STATE_DIR/npm/projects" -path '*/node_modules/@openclaw/codex/package.json' -print
grep -R '"@openclaw/codex"' "$OPENCLAW_STATE_DIR/npm/projects"/*/package-lock.json
```

For live provider E2E, source the real API key from a trusted shell or CI
secret before launching the test command. Do not print keys; report only the
source and whether the key was present.
