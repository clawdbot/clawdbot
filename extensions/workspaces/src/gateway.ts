import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { rememberWorkspaceBroadcast } from "./broadcast.js";
import { resolveBinding, type ResolveBindingOptions } from "./data-read.js";
import { snapshotApprovedWidget } from "./manifest.js";
import { scaffoldWorkspaceWidget } from "./scaffold.js";
import {
  validateWorkspaceDoc,
  type WorkspaceActor,
  type WorkspaceBinding,
  type WorkspaceGrid,
  type WorkspaceTab,
  type WorkspaceWidget,
  type JsonValue,
  type WorkspaceDoc,
} from "./schema.js";
import { WorkspaceStore } from "./store.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;
// Approving agent-authored widget code is an approval decision, not an ordinary
// layout write: it is the gate that lets untrusted HTML mount and be served.
// Holding operator.write must not be enough to self-approve.
const APPROVE_SCOPE = "operator.approvals" as const;
const TAB_SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;
const WIDGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;
const CUSTOM_WIDGET_NAME_PATTERN = /^(?!__proto__$)[A-Za-z0-9._-]{1,64}$/;

type GatewayMethodContext = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];
type GatewayRespond = GatewayMethodContext["respond"];
type GatewayBroadcast = GatewayMethodContext["context"]["broadcast"];

type WorkspaceGatewayMethodOptions = {
  api: OpenClawPluginApi;
  store?: WorkspaceStore;
  dataRead?: ResolveBindingOptions;
};

function respondError(respond: GatewayRespond, error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "workspace_error";
  respond(false, undefined, { code, message: formatErrorMessage(error) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function approvedFilesMatch(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

function readParams(params: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!isRecord(params)) {
    throw new Error("params must be an object");
  }
  for (const key of Object.keys(params)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`unexpected param: ${key}`);
    }
  }
  return params;
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
  description: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${description} is required`);
  }
  return value.trim();
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value.trim();
}

// Gateway RPC is the operator's surface (Control UI and CLI). Provenance is
// derived from the caller, never read from params: a caller-supplied `RPC_ACTOR`
// would let an operator forge `agent:<id>` chips, and let any agent that can
// reach an operator.write RPC forge `user`.
const RPC_ACTOR: WorkspaceActor = "user";

function readSlug(record: Record<string, unknown>, key = "slug"): string {
  const slug = readRequiredString(record, key, key);
  if (!TAB_SLUG_PATTERN.test(slug)) {
    throw new Error(`${key} is invalid`);
  }
  return slug;
}

function readWidgetId(record: Record<string, unknown>, key = "id"): string {
  const id = readRequiredString(record, key, key);
  if (!WIDGET_ID_PATTERN.test(id)) {
    throw new Error(`${key} is invalid`);
  }
  return id;
}

function readBooleanPatch(record: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function readGrid(value: unknown, path = "grid"): WorkspaceGrid {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!["x", "y", "w", "h"].includes(key)) {
      throw new Error(`${path}.${key} is not allowed`);
    }
  }
  return {
    x: readGridInt(value.x, `${path}.x`, 0, 11),
    y: readGridInt(value.y, `${path}.y`, 0, 499),
    w: readGridInt(value.w, `${path}.w`, 1, 12),
    h: readGridInt(value.h, `${path}.h`, 1, 20),
  };
}

function readGridInt(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${path} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function slugBase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

function makeUniqueSlug(title: string, tabs: WorkspaceTab[]): string {
  const used = new Set(tabs.map((tab) => tab.slug));
  const base = slugBase(title) || "tab";
  if (!used.has(base)) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  throw new Error("could not generate a unique tab slug");
}

function makeWidgetIdBase(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || `w_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  );
}

function makeUniqueWidgetId(widget: Record<string, unknown>, doc: WorkspaceDoc): string {
  const existing = new Set(doc.tabs.flatMap((tab) => tab.widgets.map((entry) => entry.id)));
  const explicit = widget.id;
  if (explicit !== undefined) {
    if (typeof explicit !== "string" || !WIDGET_ID_PATTERN.test(explicit)) {
      throw new Error("widget.id is invalid");
    }
    if (existing.has(explicit)) {
      throw new Error(`duplicate widget id: ${explicit}`);
    }
    return explicit;
  }
  const title =
    typeof widget.title === "string"
      ? widget.title
      : typeof widget.kind === "string"
        ? widget.kind
        : "widget";
  const base = makeWidgetIdBase(title);
  if (!existing.has(base)) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 48 - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  throw new Error("could not generate a unique widget id");
}

function findTab(doc: WorkspaceDoc, slug: string): WorkspaceTab {
  const tab = doc.tabs.find((entry) => entry.slug === slug);
  if (!tab) {
    throw new Error(`workspace tab not found: ${slug}`);
  }
  return tab;
}

function findWidget(tab: WorkspaceTab, id: string): WorkspaceWidget {
  const widget = tab.widgets.find((entry) => entry.id === id);
  if (!widget) {
    throw new Error(`workspace widget not found: ${id}`);
  }
  return widget;
}

function readWidgetInput(
  value: unknown,
  doc: WorkspaceDoc,
  actor: WorkspaceActor,
): WorkspaceWidget {
  if (!isRecord(value)) {
    throw new Error("widget must be an object");
  }
  for (const key of Object.keys(value)) {
    if (
      !["id", "kind", "title", "grid", "collapsed", "hidden", "bindings", "props"].includes(key)
    ) {
      throw new Error(`widget.${key} is not allowed`);
    }
  }
  const title = readOptionalString(value, "title");
  return {
    id: makeUniqueWidgetId(value, doc),
    kind: readRequiredString(value, "kind", "widget.kind"),
    ...(title !== undefined ? { title } : {}),
    grid: readGrid(value.grid, "widget.grid"),
    collapsed: value.collapsed === undefined ? false : readRequiredBoolean(value, "collapsed"),
    hidden: value.hidden === undefined ? false : readRequiredBoolean(value, "hidden"),
    createdBy: actor,
    ...(value.bindings !== undefined
      ? { bindings: value.bindings as Record<string, WorkspaceBinding> }
      : {}),
    ...(value.props !== undefined ? { props: value.props as JsonValue } : {}),
  };
}

function readRequiredBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function readTabPatch(value: unknown): Partial<Pick<WorkspaceTab, "title" | "icon" | "hidden">> {
  const patch = readParams(value, ["title", "icon", "hidden"]);
  const title = readOptionalString(patch, "title");
  if (title !== undefined && (title.length < 1 || title.length > 80)) {
    throw new Error("patch.title must be 1-80 characters");
  }
  const icon = readOptionalString(patch, "icon");
  if (icon !== undefined && icon.length > 40) {
    throw new Error("patch.icon must be 40 characters or fewer");
  }
  const hidden = readBooleanPatch(patch, "hidden");
  return {
    ...(title !== undefined ? { title } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(hidden !== undefined ? { hidden } : {}),
  };
}

function readWidgetPatch(value: unknown): Partial<WorkspaceWidget> {
  const patch = readParams(value, ["title", "grid", "collapsed", "hidden", "bindings", "props"]);
  const title = readOptionalString(patch, "title");
  if (title !== undefined && title.length > 80) {
    throw new Error("patch.title must be 80 characters or fewer");
  }
  return {
    ...(title !== undefined ? { title } : {}),
    ...(patch.grid !== undefined ? { grid: readGrid(patch.grid, "patch.grid") } : {}),
    ...(readBooleanPatch(patch, "collapsed") !== undefined
      ? { collapsed: readBooleanPatch(patch, "collapsed")! }
      : {}),
    ...(readBooleanPatch(patch, "hidden") !== undefined
      ? { hidden: readBooleanPatch(patch, "hidden")! }
      : {}),
    ...(patch.bindings !== undefined
      ? { bindings: patch.bindings as Record<string, WorkspaceBinding> }
      : {}),
    ...(patch.props !== undefined ? { props: patch.props as JsonValue } : {}),
  };
}

function readLayout(value: unknown): Array<{ id: string; grid: WorkspaceGrid }> {
  if (!Array.isArray(value)) {
    throw new Error("layout must be an array");
  }
  return value.map((entry, index) => {
    const record = readParams(entry, ["id", "grid"]);
    return {
      id: readWidgetId(record),
      grid: readGrid(record.grid, `layout[${index}].grid`),
    };
  });
}

function appendMissingTabsToOrder(doc: WorkspaceDoc): void {
  const seen = new Set(doc.prefs.tabOrder);
  for (const tab of doc.tabs) {
    if (!seen.has(tab.slug)) {
      doc.prefs.tabOrder.push(tab.slug);
    }
  }
}

function broadcastChange(
  broadcast: GatewayBroadcast,
  params: { doc: WorkspaceDoc; actor: WorkspaceActor; changedTabSlug?: string },
) {
  // Agent tool calls outside a gateway request reuse this handle; see broadcast.ts.
  rememberWorkspaceBroadcast(broadcast);
  broadcast("plugin.workspaces.changed", {
    workspaceVersion: params.doc.workspaceVersion,
    ...(params.changedTabSlug ? { changedTabSlug: params.changedTabSlug } : {}),
    actor: params.actor,
  });
}

async function respondWrite(
  opts: GatewayMethodContext,
  actor: WorkspaceActor,
  changedTabSlug: string | undefined,
  run: () => Promise<{ doc: WorkspaceDoc }>,
) {
  const result = await run();
  broadcastChange(opts.context.broadcast, { doc: result.doc, actor, changedTabSlug });
  opts.respond(true, { doc: result.doc, workspaceVersion: result.doc.workspaceVersion });
}

export function registerWorkspaceGatewayMethods(options: WorkspaceGatewayMethodOptions) {
  const { api } = options;
  const store = options.store ?? new WorkspaceStore();

  api.registerGatewayMethod(
    "workspaces.get",
    async ({ respond, context }) => {
      try {
        rememberWorkspaceBroadcast(context.broadcast);
        const doc = store.read();
        respond(true, { doc, workspaceVersion: doc.workspaceVersion });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.widget.frame",
    async ({ params: rawParams, respond }) => {
      try {
        const params = readParams(rawParams, ["name"]);
        const name = readRequiredString(params, "name", "name");
        if (!CUSTOM_WIDGET_NAME_PATTERN.test(name)) {
          throw new Error("name is invalid");
        }
        const entry = store.widgetEntry(name);
        if (entry?.status !== "approved" || !entry.approvedFiles) {
          throw new Error(`workspace widget is not approved: ${name}`);
        }
        const snapshot = await snapshotApprovedWidget(name, { stateDir: store.stateDir });
        if (!approvedFilesMatch(snapshot.files, entry.approvedFiles)) {
          throw new Error(`workspace widget approval no longer matches: ${name}`);
        }
        const frameToken = store.assetTokens.issue(name, entry.approvedFiles);
        const frameExpiresAt = store.assetTokens.expiresAt(frameToken, name);
        if (frameExpiresAt === null) {
          throw new Error(`workspace widget frame capability failed: ${name}`);
        }
        respond(true, {
          manifest: snapshot.manifest,
          frameToken,
          frameExpiresAt,
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.tab.create",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["slug", "title", "icon"]);
        const title = readRequiredString(params, "title", "title");
        const icon = readOptionalString(params, "icon");
        const result = store.mutate(
          (draft) => {
            const slug =
              params.slug === undefined ? makeUniqueSlug(title, draft.tabs) : readSlug(params);
            if (draft.tabs.some((tab) => tab.slug === slug)) {
              throw new Error(`workspace tab already exists: ${slug}`);
            }
            draft.tabs.push({
              slug,
              title,
              ...(icon !== undefined ? { icon } : {}),
              hidden: false,
              createdBy: RPC_ACTOR,
              widgets: [],
            });
            draft.prefs.tabOrder.push(slug);
          },
          { actor: RPC_ACTOR },
        );
        const changedTabSlug = result.doc.tabs.at(-1)?.slug;
        broadcastChange(opts.context.broadcast, {
          doc: result.doc,
          actor: RPC_ACTOR,
          changedTabSlug,
        });
        opts.respond(true, { doc: result.doc, workspaceVersion: result.doc.workspaceVersion });
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.tab.update",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["slug", "patch"]);
        const slug = readSlug(params);
        const patch = readTabPatch(params.patch);
        await respondWrite(opts, RPC_ACTOR, slug, async () =>
          store.mutate(
            (draft) => {
              Object.assign(findTab(draft, slug), patch);
            },
            { actor: RPC_ACTOR },
          ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.tab.delete",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["slug"]);
        const slug = readSlug(params);
        await respondWrite(opts, RPC_ACTOR, slug, async () =>
          store.mutate(
            (draft) => {
              const nextTabs = draft.tabs.filter((tab) => tab.slug !== slug);
              if (nextTabs.length === draft.tabs.length) {
                throw new Error(`workspace tab not found: ${slug}`);
              }
              draft.tabs = nextTabs;
              draft.prefs.tabOrder = draft.prefs.tabOrder.filter((entry) => entry !== slug);
            },
            { actor: RPC_ACTOR },
          ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.tab.reorder",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["order"]);
        const order = readSlugOrder(params.order);
        await respondWrite(opts, RPC_ACTOR, undefined, async () =>
          store.mutate(
            (draft) => {
              const slugs = new Set(draft.tabs.map((tab) => tab.slug));
              for (const slug of order) {
                if (!slugs.has(slug)) {
                  throw new Error(`workspace tab not found: ${slug}`);
                }
              }
              draft.prefs.tabOrder = order;
              appendMissingTabsToOrder(draft);
            },
            { actor: RPC_ACTOR },
          ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.widget.add",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["tab", "widget"]);
        const slug = readRequiredString(params, "tab", "tab");
        await respondWrite(opts, RPC_ACTOR, slug, async () =>
          store.mutate(
            (draft) => {
              findTab(draft, slug).widgets.push(readWidgetInput(params.widget, draft, RPC_ACTOR));
            },
            { actor: RPC_ACTOR },
          ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.widget.update",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["tab", "id", "patch"]);
        const slug = readRequiredString(params, "tab", "tab");
        const id = readWidgetId(params);
        const patch = readWidgetPatch(params.patch);
        await respondWrite(opts, RPC_ACTOR, slug, async () =>
          store.mutate(
            (draft) => {
              Object.assign(findWidget(findTab(draft, slug), id), patch);
            },
            { actor: RPC_ACTOR },
          ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.widget.move",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["tab", "id", "grid", "toTab"]);
        if (params.grid !== undefined && params.toTab !== undefined) {
          throw new Error("workspaces.widget.move accepts either grid or toTab, not both");
        }
        const id = readWidgetId(params);
        const changedTabSlug =
          typeof params.toTab === "string"
            ? params.toTab
            : typeof params.tab === "string"
              ? params.tab
              : undefined;
        await respondWrite(opts, RPC_ACTOR, changedTabSlug, async () =>
          store.mutate(
            (draft) => {
              if (params.grid !== undefined) {
                const slug = readRequiredString(params, "tab", "tab");
                findWidget(findTab(draft, slug), id).grid = readGrid(params.grid);
                return;
              }
              const toTab = readRequiredString(params, "toTab", "toTab");
              const destination = findTab(draft, toTab);
              for (const tab of draft.tabs) {
                const index = tab.widgets.findIndex((widget) => widget.id === id);
                if (index >= 0) {
                  destination.widgets.push(tab.widgets.splice(index, 1)[0]!);
                  return;
                }
              }
              throw new Error(`workspace widget not found: ${id}`);
            },
            { actor: RPC_ACTOR },
          ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.widget.remove",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["tab", "id"]);
        const slug = readRequiredString(params, "tab", "tab");
        const id = readWidgetId(params);
        await respondWrite(opts, RPC_ACTOR, slug, async () =>
          store.mutate(
            (draft) => {
              const tab = findTab(draft, slug);
              const next = tab.widgets.filter((widget) => widget.id !== id);
              if (next.length === tab.widgets.length) {
                throw new Error(`workspace widget not found: ${id}`);
              }
              tab.widgets = next;
            },
            { actor: RPC_ACTOR },
          ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.widget.setLayout",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["tab", "layout"]);
        const slug = readRequiredString(params, "tab", "tab");
        const layout = readLayout(params.layout);
        await respondWrite(opts, RPC_ACTOR, slug, async () =>
          store.mutate(
            (draft) => {
              const tab = findTab(draft, slug);
              for (const entry of layout) {
                findWidget(tab, entry.id).grid = entry.grid;
              }
            },
            { actor: RPC_ACTOR },
          ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  // Scaffolding over RPC exists so the CLI creates a widget through the same
  // store path the agent tool uses. Without it the CLI had to read-modify-write
  // the whole document through `workspace.replace`, which is both racy and the
  // only way it could mark its own widget approved.
  api.registerGatewayMethod(
    "workspaces.widget.scaffold",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["name", "title"]);
        const name = readRequiredString(params, "name", "name");
        const title = readOptionalString(params, "title");
        const scaffold = await scaffoldWorkspaceWidget({
          name,
          ...(title !== undefined ? { title } : {}),
          stateDir: store.stateDir,
          createdBy: RPC_ACTOR,
        });
        const result = store.mutate(
          (draft) => {
            // Operator-scaffolded or agent-scaffolded, a widget always starts
            // pending: approval is a separate, separately-scoped decision.
            draft.widgetsRegistry[scaffold.name] = { status: "pending", createdBy: RPC_ACTOR };
          },
          { actor: RPC_ACTOR },
        );
        broadcastChange(opts.context.broadcast, { doc: result.doc, actor: RPC_ACTOR });
        opts.respond(true, {
          ...scaffold,
          registry: result.doc.widgetsRegistry[scaffold.name],
          workspaceVersion: result.doc.workspaceVersion,
        });
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.widget.approve",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["name", "decision"]);
        const name = readRequiredString(params, "name", "name");
        if (!CUSTOM_WIDGET_NAME_PATTERN.test(name)) {
          throw new Error("name is invalid");
        }
        const decision = readRequiredString(params, "decision", "decision");
        if (decision !== "approved" && decision !== "rejected") {
          throw new Error("decision must be approved or rejected");
        }
        // What the operator approves is the code on disk, not the name. Freeze a
        // digest of every servable file: the route re-hashes what it reads, so an
        // agent cannot win approval on one tree and then write another.
        // One read of the widget directory: the manifest is parsed from the same
        // bytes that are hashed, so no swap can slip between validation and freeze.
        const approvedFiles =
          decision === "approved"
            ? (await snapshotApprovedWidget(name, { stateDir: store.stateDir })).files
            : undefined;
        const result = store.mutate(
          (draft) => {
            const existing = draft.widgetsRegistry[name];
            if (!existing) {
              throw new Error(`workspace widget not found: ${name}`);
            }
            draft.widgetsRegistry[name] = {
              status: decision,
              createdBy: existing.createdBy,
              ...(approvedFiles
                ? {
                    approvedBy: RPC_ACTOR,
                    approvedAt: new Date().toISOString(),
                    approvedFiles,
                  }
                : {}),
            };
          },
          { actor: RPC_ACTOR },
        );
        broadcastChange(opts.context.broadcast, { doc: result.doc, actor: RPC_ACTOR });
        // A connection holding only operator.approvals must not read the workspace
        // through this method; `workspaces.get` is the operator.read door.
        opts.respond(true, {
          name,
          registry: result.doc.widgetsRegistry[name],
          workspaceVersion: result.doc.workspaceVersion,
        });
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: APPROVE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.replace",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["doc"]);
        const doc = validateWorkspaceDoc(params.doc);
        await respondWrite(opts, RPC_ACTOR, undefined, async () =>
          store.replace(doc, { actor: RPC_ACTOR }),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.undo",
    async (opts) => {
      try {
        readParams(opts.params, []);
        const doc = store.undo();
        broadcastChange(opts.context.broadcast, { doc, actor: RPC_ACTOR });
        opts.respond(true, { doc, workspaceVersion: doc.workspaceVersion });
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.data.read",
    async ({ params: requestParams, respond }) => {
      try {
        const params = readParams(requestParams, ["binding"]);
        respond(true, {
          data: await resolveBinding(params.binding, options.dataRead),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );
}

function readSlugOrder(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("order must be an array");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !TAB_SLUG_PATTERN.test(entry)) {
      throw new Error(`order[${index}] is invalid`);
    }
    if (seen.has(entry)) {
      throw new Error(`order contains duplicate slug: ${entry}`);
    }
    seen.add(entry);
    return entry;
  });
}
