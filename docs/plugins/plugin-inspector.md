---
summary: "Use Plugin Inspector to catch OpenClaw plugin compatibility issues locally and in CI"
title: "Plugin Inspector"
sidebarTitle: "Plugin Inspector"
doc-schema-version: 1
read_when:
  - You are validating an OpenClaw plugin before publishing
  - You want compatibility checks in a plugin repository
  - You need Plugin Inspector reports, SARIF, or JUnit output in CI
---

[`@openclaw/plugin-inspector`](https://github.com/openclaw/plugin-inspector) is
the offline compatibility checker for OpenClaw plugin packages. It inspects
package metadata, `openclaw.plugin.json`, SDK imports, hooks, registration
calls, and declared contracts before a plugin reaches users.

The default check is static, offline, and credential-free. It exits non-zero
for hard compatibility breakages while keeping warnings and suggestions visible
in the generated reports.

## Where it fits

Plugin Inspector complements package tests and OpenClaw runtime proof. Each
check answers a different question:

| Check                                                                    | What it proves                                                                   |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `plugin-inspector inspect --no-openclaw`                                 | The package and source look compatible without importing plugin code             |
| `plugin-inspector ci --no-openclaw`                                      | The static compatibility check plus CI summary, SARIF, and JUnit artifacts       |
| `plugin-inspector ci --no-openclaw --runtime --mock-sdk --allow-execute` | Trusted plugin code registers the expected surfaces under an isolated mocked SDK |
| `openclaw plugins build --check` and `openclaw plugins validate`         | Generated `defineToolPlugin` metadata matches the built entry                    |
| `openclaw plugins inspect <id> --runtime --json`                         | An installed plugin loads and registers against an OpenClaw runtime              |
| Plugin unit, integration, and live tests                                 | The plugin behavior and external systems work                                    |

## Recommended workflow

Run checks in increasing order of cost and trust:

1. Build the JavaScript artifact that the package will publish.
2. Run unit and integration tests.
3. Run the static Plugin Inspector check.
4. Add runtime capture when static inspection cannot prove registrations made
   by `register(api)`.
5. Install or load the packed artifact in OpenClaw and inspect its runtime.
6. Run live tests for channels, providers, services, network calls, or CLI
   backends.
7. Run a ClawHub publish dry run before release.

Runtime capture imports plugin code in an isolated subprocess. Only use
`--runtime --allow-execute` for code you trust and intend to execute.

## Quick start

Run a one-off static check from the plugin package root:

```bash
npx @openclaw/plugin-inspector inspect --no-openclaw
```

The command writes:

- `reports/plugin-inspector-report.json`
- `reports/plugin-inspector-report.md`
- `reports/plugin-inspector-issues.md`

Install the package as a development dependency when the repository needs
repeatable local scripts and CI:

```bash
npm install --save-dev @openclaw/plugin-inspector
```

Keep static and runtime scripts separate so code execution stays explicit:

```json package.json
{
  "scripts": {
    "plugin:check": "plugin-inspector inspect --no-openclaw",
    "plugin:ci": "plugin-inspector ci --no-openclaw",
    "plugin:ci:runtime": "plugin-inspector ci --no-openclaw --runtime --mock-sdk --allow-execute"
  }
}
```

Use `plugin:check` during development and run `plugin:ci` on every pull
request. Add `plugin:ci:runtime` in a separate trusted-code job when runtime
registration capture provides useful proof.

The initializer can preview and generate starter config, package scripts, and a
GitHub Actions workflow:

```bash
npx @openclaw/plugin-inspector init --ci --scripts --dry-run
npx @openclaw/plugin-inspector init --ci --scripts
```

## Assert expected registrations

Add Plugin Inspector config when a plugin must expose specific registration
surfaces. Small repositories can keep it in `package.json`:

```json package.json
{
  "pluginInspector": {
    "version": 1,
    "plugin": {
      "id": "my-plugin",
      "expect": {
        "registrations": ["registerTool"]
      }
    }
  }
}
```

Use expectations for required plugin contracts, not optional behavior. Inspect
the resolved config before adding it to CI:

```bash
npx @openclaw/plugin-inspector config --json
```

## GitHub Actions

`plugin-inspector ci` writes the normal compatibility report plus CI summary,
SARIF, and JUnit artifacts. A minimal static workflow is:

```yaml
name: plugin-inspector

on:
  pull_request:
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run plugin:ci
      - uses: actions/upload-artifact@v5
        if: always()
        with:
          name: plugin-inspector-reports
          path: reports/plugin-inspector-*
```

Run the runtime script in a separate trusted-code job or step when needed:

```yaml
- run: npm run plugin:ci:runtime
```

Keep report artifacts when a check fails so reviewers can inspect the evidence.
Pass `--author-facing` when a report should contain only findings with
plugin-author remediation guidance.

## Compare against an OpenClaw checkout

Pass `--openclaw <path>` to compare the plugin against public compatibility
surfaces from a local OpenClaw checkout:

```bash
npx @openclaw/plugin-inspector ci --openclaw ../openclaw
```

Use the same path to test against an OpenClaw beta before stable release:

```bash
export OPENCLAW_BETA_TAG="vYYYY.M.PATCH-beta.N"
git -C ../openclaw fetch --tags
git -C ../openclaw switch --detach "$OPENCLAW_BETA_TAG"
npx @openclaw/plugin-inspector ci --openclaw ../openclaw
```

The checkout comparison reads public compatibility surfaces; it does not
replace installing the plugin into that OpenClaw version and proving its
runtime behavior.

## Plugins that ship skills

Plugins can list skill directories in `openclaw.plugin.json`. Plugin Inspector
can validate the surrounding plugin package, but the shipped skills still need
skill-specific proof:

1. Confirm each directory appears in the manifest `skills` array.
2. Install or load the plugin and confirm the skills appear in
   `openclaw skills list`.
3. Start a fresh session and test both natural skill selection and explicit
   `/skill <name>` invocation.

See [Skills](/tools/skills#plugins-and-skills) and
[Creating skills](/tools/creating-skills) for skill loading, gating, and test
guidance.

## Reports and full reference

The `ci` command adds these CI-native outputs:

- `reports/plugin-inspector-ci-summary.json`
- `reports/plugin-inspector-ci-summary.md`
- `reports/plugin-inspector.sarif`
- `reports/plugin-inspector.junit.xml`

For the complete command surface, configuration schema, runtime-capture model,
and public API, see the
[Plugin Inspector repository](https://github.com/openclaw/plugin-inspector).

## Related

- [Plugin testing](/plugins/sdk-testing)
- [Building plugins](/plugins/building-plugins)
- [Tool plugins](/plugins/tool-plugins)
- [Plugin compatibility](/plugins/compatibility)
