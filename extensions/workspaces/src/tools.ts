import { jsonResult } from "openclaw/plugin-sdk/core";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { Type } from "typebox";
import { workspaceBroadcast, type WorkspaceBroadcast } from "./broadcast.js";
import {
  WorkspaceBindingResolutionError,
  DATA_READ_RPC_ALLOWLIST,
  resolveBinding,
  type ResolveBindingOptions,
} from "./data-read.js";
import { scaffoldWorkspaceWidget } from "./scaffold.js";
import {
  BUILTIN_WIDGET_KINDS,
  isWorkspaceActor,
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

type WorkspaceToolParams = {
  api: OpenClawPluginApi;
  context?: OpenClawPluginToolContext;
  store?: WorkspaceStore;
  broadcast?: WorkspaceBroadcast;
  dataRead?: ResolveBindingOptions;
};

type MutationParams = {
  store: WorkspaceStore;
  actor: WorkspaceActor;
  broadcast?: WorkspaceBroadcast;
  changedTabSlug?: string;
  mutate: (draft: WorkspaceDoc) => void | WorkspaceDoc;
};

const TAB_SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;
const WIDGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;
const TOOL_DESCRIPTION_SUFFIX = " Call workspace_get first when you need the current document.";

/**
 * Both lists below exist because a model can only see tool schemas. An agent that
 * has to brute-force the valid `kind` values or the rpc allowlist burns dozens of
 * round-trips against "kind is invalid" / "method is not allowlisted".
 */
const WIDGET_KIND_DESCRIPTION = [
  `Widget kind: custom:<name>, or one of ${BUILTIN_WIDGET_KINDS.join(", ")}.`,
  "builtin:stat-card (big number; props {label?, format?: usd|percent|int}; binding id `value`),",
  "builtin:markdown (props {markdown} or {text}, or a file binding of a .md file),",
  "builtin:table (binding id `rows`; props {columns: string[]}),",
  "builtin:iframe-embed (props {url}),",
  "builtin:sessions, builtin:usage, builtin:cron, builtin:instances, builtin:activity",
  "(each reads its own rpc binding; see workspace_get for a worked example).",
  "Charts are not builtins — author one with workspace_widget_scaffold and use custom:<name>.",
].join(" ");

const JsonSchema = Type.Unknown({
  description: "JSON-compatible value. Per-kind shapes are described on `kind`.",
});
const GridSchema = Type.Object(
  {
    x: Type.Integer({ minimum: 0, maximum: 11, description: "Grid x column, 0-11." }),
    y: Type.Integer({ minimum: 0, maximum: 499, description: "Grid row, 0-499." }),
    w: Type.Integer({ minimum: 1, maximum: 12, description: "Grid width, 1-12." }),
    h: Type.Integer({ minimum: 1, maximum: 20, description: "Grid height, 1-20." }),
  },
  { additionalProperties: false },
);
const BindingSchema = Type.Union([
  Type.Object(
    {
      source: Type.Literal("rpc"),
      method: Type.String({
        description: `Allowlisted gateway read method, one of: ${DATA_READ_RPC_ALLOWLIST.join(", ")}.`,
      }),
      params: Type.Optional(
        Type.Record(Type.String(), JsonSchema, {
          description: "Bounded JSON parameters required by the selected gateway method.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("file"),
      path: Type.String({ description: "Relative path under workspace/data." }),
      pointer: Type.Optional(Type.String({ description: "Optional JSON pointer." })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("static"),
      value: JsonSchema,
    },
    { additionalProperties: false },
  ),
]);
const BindingsRecordSchema = Type.Record(Type.String(), BindingSchema, {
  description: "Widget binding map keyed by binding id.",
});
const WidgetPatchSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ description: "Widget title, 80 chars max." })),
    grid: Type.Optional(GridSchema),
    collapsed: Type.Optional(Type.Boolean({ description: "Collapse widget body." })),
    hidden: Type.Optional(Type.Boolean({ description: "Hide widget." })),
    bindings: Type.Optional(BindingsRecordSchema),
    props: Type.Optional(JsonSchema),
  },
  { additionalProperties: false },
);
const WidgetInputSchema = Type.Object(
  {
    id: Type.Optional(Type.String({ description: "Optional unique widget id." })),
    kind: Type.String({ description: WIDGET_KIND_DESCRIPTION }),
    title: Type.Optional(Type.String({ description: "Widget title." })),
    grid: GridSchema,
    collapsed: Type.Optional(Type.Boolean({ description: "Initial collapsed state." })),
    hidden: Type.Optional(Type.Boolean({ description: "Initial hidden state." })),
    bindings: Type.Optional(BindingsRecordSchema),
    props: Type.Optional(JsonSchema),
  },
  { additionalProperties: false },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(params: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
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
  description = key,
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

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

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

function readGrid(value: unknown, pathName = "grid"): WorkspaceGrid {
  if (!isRecord(value)) {
    throw new Error(`${pathName} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!["x", "y", "w", "h"].includes(key)) {
      throw new Error(`${pathName}.${key} is not allowed`);
    }
  }
  return {
    x: readGridInt(value.x, `${pathName}.x`, 0, 11),
    y: readGridInt(value.y, `${pathName}.y`, 0, 499),
    w: readGridInt(value.w, `${pathName}.w`, 1, 12),
    h: readGridInt(value.h, `${pathName}.h`, 1, 20),
  };
}

function readGridInt(value: unknown, pathName: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${pathName} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function readBindings(value: unknown): Record<string, WorkspaceBinding> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("bindings must be an object");
  }
  return value as Record<string, WorkspaceBinding>;
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
      .replace(/-+$/g, "") || "widget"
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
  const record = readRecord(value, [
    "id",
    "kind",
    "title",
    "grid",
    "collapsed",
    "hidden",
    "bindings",
    "props",
  ]);
  const title = readOptionalString(record, "title");
  const bindings = readBindings(record.bindings);
  return {
    id: makeUniqueWidgetId(record, doc),
    kind: readRequiredString(record, "kind", "kind"),
    ...(title !== undefined ? { title } : {}),
    grid: readGrid(record.grid),
    collapsed: readOptionalBoolean(record, "collapsed") ?? false,
    hidden: readOptionalBoolean(record, "hidden") ?? false,
    createdBy: actor,
    ...(bindings !== undefined ? { bindings } : {}),
    ...(record.props !== undefined ? { props: record.props as JsonValue } : {}),
  };
}

function readWidgetPatch(value: unknown): Partial<WorkspaceWidget> {
  const record = readRecord(value, ["title", "grid", "collapsed", "hidden", "bindings", "props"]);
  const title = readOptionalString(record, "title");
  const collapsed = readOptionalBoolean(record, "collapsed");
  const hidden = readOptionalBoolean(record, "hidden");
  const bindings = readBindings(record.bindings);
  return {
    ...(title !== undefined ? { title } : {}),
    ...(record.grid !== undefined ? { grid: readGrid(record.grid) } : {}),
    ...(collapsed !== undefined ? { collapsed } : {}),
    ...(hidden !== undefined ? { hidden } : {}),
    ...(bindings !== undefined ? { bindings } : {}),
    ...(record.props !== undefined ? { props: record.props as JsonValue } : {}),
  };
}

function readLayout(value: unknown): Array<{ id: string; grid: WorkspaceGrid }> {
  if (!Array.isArray(value)) {
    throw new Error("layout must be an array");
  }
  return value.map((entry, index) => {
    const record = readRecord(entry, ["id", "grid"]);
    return {
      id: readWidgetId(record),
      grid: readGrid(record.grid, `layout[${index}].grid`),
    };
  });
}

function readOrder(value: unknown): string[] {
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

function appendMissingTabsToOrder(doc: WorkspaceDoc): void {
  const seen = new Set(doc.prefs.tabOrder);
  for (const tab of doc.tabs) {
    if (!seen.has(tab.slug)) {
      doc.prefs.tabOrder.push(tab.slug);
    }
  }
}

function contextOwner(ctx: OpenClawPluginToolContext | undefined): string {
  const record = (ctx ?? {}) as Record<string, unknown>;
  return (
    (typeof record.agentId === "string" && record.agentId) ||
    (typeof record.sessionKey === "string" && record.sessionKey) ||
    (typeof record.sessionId === "string" && record.sessionId) ||
    "agent"
  );
}

function actorFromContext(ctx: OpenClawPluginToolContext | undefined): WorkspaceActor {
  const normalized =
    contextOwner(ctx)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "agent";
  const actor = `agent:${normalized}`;
  if (!isWorkspaceActor(actor)) {
    throw new Error("tool context owner cannot be used as workspace actor");
  }
  return actor;
}

function broadcastChange(
  broadcast: WorkspaceBroadcast | undefined,
  params: { doc: WorkspaceDoc; actor: WorkspaceActor; changedTabSlug?: string },
) {
  broadcast?.("plugin.workspaces.changed", {
    workspaceVersion: params.doc.workspaceVersion,
    ...(params.changedTabSlug ? { changedTabSlug: params.changedTabSlug } : {}),
    actor: params.actor,
  });
}

function resolveWorkspaceBroadcast(
  broadcast: WorkspaceBroadcast | undefined,
): WorkspaceBroadcast | undefined {
  // The request scope only exists when the turn originated from a gateway RPC.
  // A channel/cron/heartbeat turn falls back to the remembered server handle, so
  // an agent edit still reaches every open Control UI.
  return (
    broadcast ?? getPluginRuntimeGatewayRequestScope()?.context?.broadcast ?? workspaceBroadcast()
  );
}

async function runMutation(params: MutationParams) {
  const result = params.store.mutate(params.mutate, { actor: params.actor });
  broadcastChange(params.broadcast, {
    doc: result.doc,
    actor: params.actor,
    changedTabSlug: params.changedTabSlug,
  });
  return jsonResult({ doc: result.doc, workspaceVersion: result.doc.workspaceVersion });
}

// Scaffold template (spec-50 §Scaffold): demonstrates the v1 handshake, getData +
// onData(=push), theme tokens applied to CSS vars, ZERO external requests, and a
// visible "built by <createdBy>" footer. Framework-free and < 100 lines.

function toolDescription(text: string): string {
  return `${text}${TOOL_DESCRIPTION_SUFFIX}`;
}

export function createWorkspaceTools(params: WorkspaceToolParams): AnyAgentTool[] {
  const store = params.store ?? new WorkspaceStore();
  const actor = actorFromContext(params.context);
  const broadcast = resolveWorkspaceBroadcast(params.broadcast);
  const mutationBase = {
    store,
    actor,
    broadcast,
  };
  return [
    {
      name: "workspace_get",
      label: "Workspace Get",
      description: "Read the full Workspaces document so an agent can diff before mutating it.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        const doc = store.read();
        return jsonResult({ doc, workspaceVersion: doc.workspaceVersion });
      },
    },
    {
      name: "workspace_tab_create",
      label: "Workspace Tab Create",
      description: toolDescription(
        "Create a workspace tab. Slugs are lowercase letters, digits, and dashes, max 40 chars.",
      ),
      parameters: Type.Object(
        {
          title: Type.String({ description: "Tab title, 1-80 chars." }),
          slug: Type.Optional(Type.String({ description: "Optional tab slug." })),
          icon: Type.Optional(Type.String({ description: "Optional icon name." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["title", "slug", "icon"]);
        const title = readRequiredString(record, "title", "title");
        const icon = readOptionalString(record, "icon");
        let changedTabSlug: string | undefined;
        return await runMutation({
          ...mutationBase,
          mutate: (draft) => {
            const slug =
              record.slug === undefined ? makeUniqueSlug(title, draft.tabs) : readSlug(record);
            if (draft.tabs.some((tab) => tab.slug === slug)) {
              throw new Error(`workspace tab already exists: ${slug}`);
            }
            changedTabSlug = slug;
            draft.tabs.push({
              slug,
              title,
              ...(icon !== undefined ? { icon } : {}),
              hidden: false,
              createdBy: actor,
              widgets: [],
            });
            draft.prefs.tabOrder.push(slug);
          },
          get changedTabSlug() {
            return changedTabSlug;
          },
        });
      },
    },
    {
      name: "workspace_tab_update",
      label: "Workspace Tab Update",
      description: toolDescription("Update a workspace tab title, icon, or hidden state."),
      parameters: Type.Object(
        {
          slug: Type.String({ description: "Tab slug." }),
          title: Type.Optional(Type.String({ description: "New title." })),
          icon: Type.Optional(Type.String({ description: "New icon." })),
          hidden: Type.Optional(Type.Boolean({ description: "Hide or show the tab." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["slug", "title", "icon", "hidden"]);
        const slug = readSlug(record);
        const title = readOptionalString(record, "title");
        const icon = readOptionalString(record, "icon");
        const hidden = readOptionalBoolean(record, "hidden");
        return await runMutation({
          ...mutationBase,
          changedTabSlug: slug,
          mutate: (draft) => {
            Object.assign(findTab(draft, slug), {
              ...(title !== undefined ? { title } : {}),
              ...(icon !== undefined ? { icon } : {}),
              ...(hidden !== undefined ? { hidden } : {}),
            });
          },
        });
      },
    },
    {
      name: "workspace_tab_delete",
      label: "Workspace Tab Delete",
      description: toolDescription("Delete a workspace tab and all widgets inside it."),
      parameters: Type.Object(
        { slug: Type.String({ description: "Tab slug." }) },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["slug"]);
        const slug = readSlug(record);
        return await runMutation({
          ...mutationBase,
          changedTabSlug: slug,
          mutate: (draft) => {
            const nextTabs = draft.tabs.filter((tab) => tab.slug !== slug);
            if (nextTabs.length === draft.tabs.length) {
              throw new Error(`workspace tab not found: ${slug}`);
            }
            draft.tabs = nextTabs;
            draft.prefs.tabOrder = draft.prefs.tabOrder.filter((entry) => entry !== slug);
          },
        });
      },
    },
    {
      name: "workspace_tabs_reorder",
      label: "Workspace Tabs Reorder",
      description: toolDescription("Set workspace tab order. Missing existing tabs are appended."),
      parameters: Type.Object(
        { order: Type.Array(Type.String({ description: "Tab slug." })) },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["order"]);
        const order = readOrder(record.order);
        return await runMutation({
          ...mutationBase,
          mutate: (draft) => {
            const slugs = new Set(draft.tabs.map((tab) => tab.slug));
            for (const slug of order) {
              if (!slugs.has(slug)) {
                throw new Error(`workspace tab not found: ${slug}`);
              }
            }
            draft.prefs.tabOrder = order;
            appendMissingTabsToOrder(draft);
          },
        });
      },
    },
    {
      name: "workspace_widget_add",
      label: "Workspace Widget Add",
      description: toolDescription(
        "Add a widget to a tab. Grid x+w must fit within the 12-column workspace grid.",
      ),
      parameters: Type.Object(
        {
          tab: Type.String({ description: "Target tab slug." }),
          ...WidgetInputSchema.properties,
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, [
          "tab",
          "id",
          "kind",
          "title",
          "grid",
          "collapsed",
          "hidden",
          "bindings",
          "props",
        ]);
        const tabSlug = readSlug(record, "tab");
        const widgetInput = { ...record };
        delete widgetInput.tab;
        return await runMutation({
          ...mutationBase,
          changedTabSlug: tabSlug,
          mutate: (draft) => {
            findTab(draft, tabSlug).widgets.push(readWidgetInput(widgetInput, draft, actor));
          },
        });
      },
    },
    {
      name: "workspace_widget_update",
      label: "Workspace Widget Update",
      description: toolDescription("Patch a widget title, grid, visibility, bindings, or props."),
      parameters: Type.Object(
        {
          tab: Type.String({ description: "Tab slug." }),
          id: Type.String({ description: "Widget id." }),
          ...WidgetPatchSchema.properties,
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, [
          "tab",
          "id",
          "title",
          "grid",
          "collapsed",
          "hidden",
          "bindings",
          "props",
        ]);
        const tabSlug = readSlug(record, "tab");
        const id = readWidgetId(record);
        // `tab` and `id` address the widget; everything else is the patch. Passing
        // the whole record to readWidgetPatch made this tool uncallable: its reader
        // rejects `tab`/`id` as unexpected params.
        const { tab: _tab, id: _id, ...patchInput } = record;
        const patch = readWidgetPatch(patchInput);
        return await runMutation({
          ...mutationBase,
          changedTabSlug: tabSlug,
          mutate: (draft) => {
            Object.assign(findWidget(findTab(draft, tabSlug), id), patch);
          },
        });
      },
    },
    {
      name: "workspace_widget_move",
      label: "Workspace Widget Move",
      description: toolDescription(
        "Move a widget by changing its grid OR moving it to another tab — exactly one of " +
          "`grid` and `toTab`, never both. A cross-tab move keeps the widget's old grid " +
          "position, so follow it with a second call to reposition.",
      ),
      parameters: Type.Object(
        {
          tab: Type.Optional(Type.String({ description: "Current tab slug for grid moves." })),
          id: Type.String({ description: "Widget id." }),
          grid: Type.Optional(GridSchema),
          toTab: Type.Optional(Type.String({ description: "Destination tab slug." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["tab", "id", "grid", "toTab"]);
        if (record.grid !== undefined && record.toTab !== undefined) {
          throw new Error("workspace_widget_move accepts either grid or toTab, not both");
        }
        if (record.grid === undefined && record.toTab === undefined) {
          throw new Error("workspace_widget_move requires grid or toTab");
        }
        const id = readWidgetId(record);
        const changedTabSlug =
          typeof record.toTab === "string"
            ? record.toTab
            : typeof record.tab === "string"
              ? record.tab
              : undefined;
        return await runMutation({
          ...mutationBase,
          changedTabSlug,
          mutate: (draft) => {
            if (record.grid !== undefined) {
              const tabSlug = readSlug(record, "tab");
              findWidget(findTab(draft, tabSlug), id).grid = readGrid(record.grid);
              return;
            }
            const toTab = readSlug(record, "toTab");
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
        });
      },
    },
    {
      name: "workspace_widget_remove",
      label: "Workspace Widget Remove",
      description: toolDescription("Remove a widget from a tab."),
      parameters: Type.Object(
        {
          tab: Type.String({ description: "Tab slug." }),
          id: Type.String({ description: "Widget id." }),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["tab", "id"]);
        const tabSlug = readSlug(record, "tab");
        const id = readWidgetId(record);
        return await runMutation({
          ...mutationBase,
          changedTabSlug: tabSlug,
          mutate: (draft) => {
            const tab = findTab(draft, tabSlug);
            const next = tab.widgets.filter((widget) => widget.id !== id);
            if (next.length === tab.widgets.length) {
              throw new Error(`workspace widget not found: ${id}`);
            }
            tab.widgets = next;
          },
        });
      },
    },
    {
      name: "workspace_layout_set",
      label: "Workspace Layout Set",
      description: toolDescription("Batch-update widget grids for one tab."),
      parameters: Type.Object(
        {
          tab: Type.String({ description: "Tab slug." }),
          layout: Type.Array(
            Type.Object(
              { id: Type.String({ description: "Widget id." }), grid: GridSchema },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["tab", "layout"]);
        const tabSlug = readSlug(record, "tab");
        const layout = readLayout(record.layout);
        return await runMutation({
          ...mutationBase,
          changedTabSlug: tabSlug,
          mutate: (draft) => {
            const tab = findTab(draft, tabSlug);
            for (const entry of layout) {
              findWidget(tab, entry.id).grid = entry.grid;
            }
          },
        });
      },
    },
    {
      name: "workspace_replace",
      label: "Workspace Replace",
      description: toolDescription(
        "Replace the full workspace document after local validation and size/schema caps.",
      ),
      parameters: Type.Object({ doc: Type.Unknown() }, { additionalProperties: false }),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["doc"]);
        const doc = validateWorkspaceDoc(record.doc);
        const result = store.replace(doc, { actor });
        broadcastChange(broadcast, { doc: result.doc, actor });
        return jsonResult({ doc: result.doc, workspaceVersion: result.doc.workspaceVersion });
      },
    },
    {
      name: "workspace_widget_scaffold",
      label: "Workspace Widget Scaffold",
      description: toolDescription(
        "Create a custom widget scaffold and register it as pending. Agent-authored widget code " +
          "never renders until a human approves it, and there is no tool to approve it — ask the " +
          "operator to approve from the Workspaces tab, or to run `openclaw workspaces " +
          "widget-approve <name>`. Edit the scaffolded index.html to build the widget.",
      ),
      parameters: Type.Object(
        {
          name: Type.String({ description: "Custom widget name, A-Z a-z 0-9 . _ - only." }),
          title: Type.Optional(Type.String({ description: "Widget display title." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["name", "title"]);
        const scaffold = await scaffoldWorkspaceWidget({
          name: readRequiredString(record, "name", "name"),
          title: readOptionalString(record, "title"),
          stateDir: store.stateDir,
          createdBy: actor,
        });
        const result = store.mutate(
          (draft) => {
            draft.widgetsRegistry[scaffold.name] = {
              status: "pending",
              createdBy: actor,
            };
          },
          { actor },
        );
        broadcastChange(broadcast, { doc: result.doc, actor });
        return jsonResult({
          ...scaffold,
          registry: result.doc.widgetsRegistry[scaffold.name],
          workspaceVersion: result.doc.workspaceVersion,
        });
      },
    },
    {
      name: "workspace_undo",
      label: "Workspace Undo",
      description: "Restore the newest workspace undo snapshot.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        const doc = store.undo();
        broadcastChange(broadcast, { doc, actor });
        return jsonResult({ doc, workspaceVersion: doc.workspaceVersion });
      },
    },
    {
      name: "workspace_data_read",
      label: "Workspace Data Read",
      description:
        "Resolve a workspace binding exactly as a widget sees it. `file` and `static` bindings " +
        'return their data; an `rpc` binding returns { status: "binding_client_resolved" } ' +
        "because only the trusted Control UI may call the gateway on a widget's behalf.",
      parameters: Type.Object({ binding: BindingSchema }, { additionalProperties: false }),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["binding"]);
        try {
          return jsonResult({ data: await resolveBinding(record.binding, params.dataRead) });
        } catch (error) {
          // `rpc` bindings are resolved by the trusted Control UI over its own
          // authenticated socket. That is the documented answer, not an error, so
          // return it as a result the model can act on.
          if (
            error instanceof WorkspaceBindingResolutionError &&
            error.code === "binding_client_resolved"
          ) {
            return jsonResult({ status: "binding_client_resolved", message: error.message });
          }
          throw error;
        }
      },
    },
  ];
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
