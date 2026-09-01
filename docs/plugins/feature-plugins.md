---
summary: "Build plugins with typed operations, native pages, and replaceable Control UI views"
title: "Feature plugins"
read_when:
  - You want a plugin to add a native Control UI page or customize the workspace
  - You want the same feature operation available to UI and agent tools
  - You want an agent to build and propose a local plugin artifact
---

A feature plugin can own its backend operations and its Control UI. It can add
pages, navigation, session actions, panels, dashboard widgets, and header
accessories, or provide replacements for the workspace, session list, composer,
transcript, and tool results.

Native UI runs trusted JavaScript in the Control UI origin. Install it only from
authors you trust. Native modules share the signed-in operator's Gateway
authority: `host.request` can call any method that connection's scopes allow,
including administrative methods for administrators. Use the existing sandboxed dashboard widget or MCP App
surfaces when the content should be isolated from the host application.

Open the Control UI served by the connected Gateway. Native plugin assets
require that same origin; a separately hosted UI connected to another Gateway
cannot load them and explains which Control UI to open.

## Create a feature plugin

```bash
openclaw plugins init draft-review --name "Draft Review" --type feature
cd draft-review
npm install
npm run build
npm run validate
openclaw plugins install .
openclaw gateway restart
```

The scaffold includes a draft-analysis operation, an agent tool, a native page,
and a composer replacement. Open Draft Review from the Control UI sidebar, or
choose Draft composer in the UI customization controls. Choose Built-in to
restore a view. Replacement selection belongs to the current browser runtime;
it is not a persistent configuration setting.

The project has three public SDK imports:

| Import                                 | Purpose                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `openclaw/plugin-sdk/feature-contract` | Shared operation schemas, typed clients, and event subscriptions; browser safe.                  |
| `openclaw/plugin-sdk/feature-plugin`   | Register backend implementations as session actions, optional agent tools, and command adapters. |
| `openclaw/plugin-sdk/control-ui`       | Native browser activation, host capabilities, contribution types, and component mounts.          |

Browser code owns its DOM and bundles its framework dependencies. It does not
import Control UI internals or return the host framework's templates.

## Define operations once

`defineFeatureContract` declares named queries and actions with TypeBox input
and output schemas. `defineFeaturePlugin` implements them through
`setup(api, events)` and registers each operation on the existing plugin session
action transport. Queries require `operator.read`; actions require
`operator.write`.

An operation with a `tool` declaration also registers an agent tool. Optional
command adapters parse the actual command context and format the result. The
handler receives a discriminated invocation context: `source` is
`session-action`, `tool`, or `command`, with the original context for that
surface. Tool policy, authenticated command handling, and Gateway scope checks
remain owned by their existing execution paths.

Use `createFeatureClient(contract, context.host)` inside a browser view:

```typescript
const feature = createFeatureClient(contract, context.host);
const report = await feature.invoke("analyze", { text: "A draft to inspect" });
context.signal.throwIfAborted();
output.textContent = `${report.words} words`;
```

Backend inputs, outputs, and events are validated as bounded JSON. Define
meaningful limits in the schemas as well. Use the plugin's existing runtime
and storage APIs for durable state and services.

For changing data, declare events in the contract and emit them through the
`events` argument after the plugin service has started. A client can subscribe
with `feature.on(...)` or use `feature.watch(query, input, options)` to request
a fresh snapshot initially, after named events, and after reconnect. `watch`
requires `onChange` and `onError`, returns a disposer, and rejects stale results
after a newer refresh or view disposal. It does not poll.

## Contribute and replace views

Export `defineControlUiPlugin({ id, activate(host) })` from the browser entry.
Its id must match the plugin manifest. Register contributions through
`host.ui`; each registration returns a disposer.

| Registration                            | Host placement                                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `registerPage` and `registerNavigation` | Plugin-owned routes and sidebar destinations.                                                                                           |
| `registerAction`                        | Composer, header, or session menu actions. An optional `resolve` function supplies the current label, hidden state, and disabled state. |
| `registerPanel`                         | Session panels.                                                                                                                         |
| `registerAccessory`                     | Session header content.                                                                                                                 |
| `registerWidget`                        | Native dashboard widget views.                                                                                                          |
| `registerReplacement`                   | `workspace`, `session-list`, `composer`, `transcript`, or `tool-result`.                                                                |

For a dashboard widget, also register a backend
`api.session.controls.registerControlUiDescriptor` with `surface: "widget"`,
the same widget `id`, and its `requiredScopes`. The Gateway advertises widget
kinds for the current connection's scopes; a native view renders only when its
matching backend descriptor is advertised.

Use `host.ui.invalidate()` when plugin-owned state changes the presentation of
an action or another contribution. Namespace custom elements and CSS with the
plugin id so independently bundled plugins can coexist.

A view mounts into an `HTMLElement` and receives `context.host`, `props`,
`signal`, `presented`, and `mountDefault`. Return an object with `update`,
`focus`, and `dispose` as needed. Surface props and presentation changes arrive
through `update`; use `context.host.subscribe(...)` to observe host snapshot
changes. A hidden view remains mounted with the same host lifetime; use
`presented` to pause visual work while preserving its state. Disposal aborts the
view's signal and retires its host handles. Check the signal after asynchronous
work and release plugin resources in `dispose`.

Session-bound views and actions receive `sessionKey` and `agentId`. Carry both
when making a session request: the application's selected agent can differ from
the view's agent. Changing either part of that identity retires the old view's
handles, including retained composer operations. Header and composer actions also
retire when their pane stops being presented. A later return to that pane allows
new actions; it does not revive handles from an earlier invocation.

Replacements can compose the built-in view by calling
`context.mountDefault(container)`. A workspace replacement should use this
when it wants to retain the built-in chat state and session owners. The SDK
does not expose a separate headless chat service for a completely independent
workspace.

A composer replacement receives the current draft, admission state, disabled
reason, and canonical `setDraft`, `send`, and optional `abort` operations. Use
these operations instead of issuing a raw chat RPC. `send()` resolves `true`
when admitted, `false` when rejected, or `undefined` for a local command or no
submission. Show rejected submissions rather than clearing the draft.

The host also exposes session and agent snapshots and operations, plugin page
navigation, authenticated requests, and subscriptions. Session and agent
`refresh()` operations fetch new snapshots and reject on failure, so a plugin
can display an error and offer Retry. `host.sessions.rows` is the current
filtered, paginated session list. `host.sessions.refresh()` preserves that
list's filters. Use `host.sessions.observe(query, onChange)` to maintain an
independent session query without replacing it. The query accepts `agentId`,
`search`, `archived` (`true`, `false`, or `"all"`), `limit`, `configuredAgentsOnly`,
`includeGlobal`, `includeUnknown`, `includeDerivedTitles`, and
`includeLastMessage`. The callback receives `{ result, loading, error }`,
starting with the current snapshot; `result` is null until data is available.
Results contain `sessions` and the Gateway's `hasMore`, `nextOffset`, and
`totalCount` pagination metadata.

The host fetches the query and keeps it current through session events,
observer recovery, and its normal deletion handling. `observe` returns
`{ refresh, dispose }`: call `refresh()` for an explicit retry and `dispose()`
when the query is no longer needed. Errors appear in the snapshot, and an
explicit refresh rejects on failure. View disposal also releases its queries;
retained handles and unfinished refreshes reject after that lifetime ends.

A missing row in a filtered or incomplete list does not prove that a session
was deleted. Pending deletions can also hide rows before pagination metadata
changes. Pass `{ sessionKey: row.key, agentId: row.agentId }` to
`host.sessions.open`, `host.sessions.patch`, and a dashboard's `session` prop.
Carry the identity from the returned row: a raw `global` key belongs to its
queried agent, not the current selection or a card's assigned agent. Treat an
unresolved or ambiguous search as unknown. Session action presentation updates
when the roster changes, and actions check the current row again when invoked.
Actions can inspect `session.hasActiveRun`; an absent value means activity is
not yet known.
`host.components`
mounts host-owned dialogs, agent pickers, and session dashboards from plain
props and DOM content. Each component returns `update` and `dispose` methods;
the host retains permission checks, focus handling, and dashboard provider
ownership.

## Build and reload

`package.json` names the browser **source**:

```json
{
  "openclaw": {
    "extensions": ["./dist/index.js"],
    "controlUi": "./src/control-ui.ts"
  }
}
```

`openclaw plugins build` bundles that source and its browser dependencies with
the plugin's `esbuild` dev dependency. It writes immutable JavaScript and CSS
under `dist/control-ui/<content-hash>/`, then publishes their paths in
`openclaw.plugin.json.controlUi`. A failed build leaves the previous manifest
and assets usable. `plugins validate` and `plugins build --check` detect stale
source, assets, or generated metadata.

The build emits one self-contained JavaScript entry and optional CSS. Embed
other static assets in the bundle; arbitrary files and split lazy chunks are
outside this build contract. Imports must be analyzable by esbuild: literal
paths and supported glob imports work; unresolved dynamic imports, indirect
`require` calls, and `require.resolve` are rejected. Each asset is limited to
4 MiB, with an 8 MiB limit for the whole plugin browser build.

Plugins with prebuilt browser bundles can omit `package.json.openclaw.controlUi`
and declare the built entry and styles in `openclaw.plugin.json.controlUi`.
Packing and serving include JavaScript and CSS dependencies under that entry's
directory, including nested chunks and imported stylesheets, with the same byte
limits. TypeScript sources, source maps, and hidden files are excluded. Keep all browser
dependencies inside that directory; traversal is limited to eight nested directory
levels and 128 entries, counting both files and directories.

After browser-only edits, rebuild the installed plugin and use **Reload plugin
UI** as an administrator. The Gateway captures a fresh asset revision and
notifies connected browsers. Asset loading or activation failures are reported
in the UI customization controls; the previous working activation is retained
when possible. Retry after correcting the plugin, or select Built-in to
recover a replaced view.

Advertised asset revisions remain available for the lifetime of their backend
plugin, including imports needed by an older tab or a retained working view.
The shared cache holds at most 256 revisions and 64 MiB across all native
plugins. When it fills, reload refuses the new build and preserves advertised
assets. Restart the Gateway, then retry the reload.

On first activation, plugin pages and dashboard widgets show a loading state
while the catalog, asset authorization, and initializer complete. Each plugin
becomes available independently of other plugins that are still loading. A
disconnected view waits for the Gateway connection before checking availability.
Widgets show initialization failures with a Retry action.

Registrations and replacement selections made during activation publish
together after initialization succeeds. Disposing a registration before that
point also cancels its pending selection. Invalid selections reject the new
activation without retiring the preceding working UI.

Selected replacements survive a successful revision when the contribution
still exists for that surface. Unregistering the contribution, removing its
plugin, or reconnecting clears the choice; reusing an ID does not restore it.

Custom element definitions belong to the browser document. If a plugin changes
an existing custom element class, reload the browser tab as well, or use a new
versioned tag name.

Backend changes still use the normal plugin update and Gateway restart. Browser
reload does not replace backend services or change an already running agent's
tool catalog.

## Approve an agent-built artifact

After building and validating, produce an import archive:

```bash
openclaw plugins pack --root . --out ./draft-review.tgz --json
```

The receipt contains the absolute archive path, SHA-256 digest, plugin id, and
`plugin_activate_artifact` request. Packing bundles backend dependencies, keeps
the host `openclaw` imports external, and includes the manifest and compiled UI.
The archive contains no install scripts or runtime package dependencies. It
must have one backend entry; features that require separate runtime files need
the normal reviewed package-install flow. Packing rejects backend references to
`import.meta`, `__dirname`, `__filename`, and `require.resolve`, including those
in bundled dependencies, because their original files and locations do not
travel with the artifact. Import JSON or embed other resources in the backend
build instead.

Backend imports must also be analyzable by esbuild. Direct CommonJS imports
work, including Node builtins and the host SDK. Unresolved dynamic imports,
indirect `require` calls, and prebundles with opaque runtime loaders are rejected.
Provide an entry compiled without those loaders so packing can bundle its
dependencies, or use the normal package-install flow.

The system agent can propose activation with that path and digest. Before
approval, OpenClaw verifies and retains the exact archive and inspects its
declared capabilities and native UI presence without executing the plugin.
Approved application uses those retained bytes through the managed plugin
installer. Changing the source file while approval is pending cannot change
what is installed. Existing install policy and capability checks still apply.

Pending imports expire after one hour. OpenClaw keeps at most eight pending
archives of up to 32 MiB each and prunes expired or oldest imports when another
proposal is prepared. An expired or evicted review requires a fresh proposal.
Approved archives are retained separately as the install source, including when
an installer error leaves the final installation outcome uncertain.

Artifact activation currently requires plugin configuration in the root config
file without a root-level `$include`. For a `plugins` section containing only
`$include: "plugins.json5"` (a single file under the config directory with no
nested includes), use `openclaw plugins install <archive>` from a trusted shell.
The regular installer also rejects root-level, nested, and external include
layouts; adjust those layouts before installation.

Artifact activation also refuses to replace the plugin backing OpenClaw's active
inference route. Stop OpenClaw and install that artifact from a trusted shell.

After the Gateway restarts, inspect `plugins.controlUi.status` to see activation
reports from currently connected Control UI clients. A report names the plugin
revision and either `activated` or `failed`; it is a browser activation receipt,
not proof that every feature operation has been exercised. No connected browser
means no browser activation receipt yet.

For the underlying manifest fields, see [Plugin manifest](/plugins/manifest).
For install, update, and removal, see [Manage plugins](/plugins/manage-plugins).
