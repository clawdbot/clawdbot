import { DATA_READ_RPC_ALLOWLIST, normalizeWorkspaceDataLogicalPath } from "./binding-contract.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type WorkspaceActor = "user" | "system" | `agent:${string}`;
export type WorkspaceGrid = { x: number; y: number; w: number; h: number };
export type WorkspaceRpcBinding = {
  source: "rpc";
  method: string;
  params?: Record<string, JsonValue>;
};
export type WorkspaceFileBinding = { source: "file"; path: string; pointer?: string };
export type WorkspaceStaticBinding = { source: "static"; value: JsonValue };
export type WorkspaceBinding = WorkspaceRpcBinding | WorkspaceFileBinding | WorkspaceStaticBinding;
export type WorkspaceWidget = {
  id: string;
  kind: string;
  title?: string;
  grid: WorkspaceGrid;
  collapsed: boolean;
  hidden: boolean;
  /** Provenance stamp; the Control UI renders an "AI" chip for `agent:<id>`. */
  createdBy: WorkspaceActor;
  bindings?: Record<string, WorkspaceBinding>;
  props?: JsonValue;
};
export type WorkspaceTab = {
  slug: string;
  title: string;
  icon?: string;
  hidden: boolean;
  createdBy: WorkspaceActor;
  widgets: WorkspaceWidget[];
};
export type WorkspaceWidgetRegistryEntry = {
  status: "pending" | "approved" | "rejected";
  createdBy: WorkspaceActor;
  approvedBy?: WorkspaceActor;
  approvedAt?: string;
  /** sha256 of every servable file, keyed by logical path, frozen at approval. */
  approvedFiles?: Record<string, string>;
};
export type WorkspaceDoc = {
  schemaVersion: 1;
  workspaceVersion: number;
  tabs: WorkspaceTab[];
  widgetsRegistry: Record<string, WorkspaceWidgetRegistryEntry>;
  prefs: { tabOrder: string[] };
};

export const CURRENT_WORKSPACE_SCHEMA_VERSION = 1;

const TAB_SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;
const ACTOR_PATTERN = /^(user|system|agent:[A-Za-z0-9._-]{1,64})$/;
const WIDGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;
/** The trusted widget set. Exported so tool schemas can name them for the model. */
export const BUILTIN_WIDGET_KINDS = [
  "builtin:stat-card",
  "builtin:markdown",
  "builtin:table",
  "builtin:iframe-embed",
  "builtin:sessions",
  "builtin:usage",
  "builtin:cron",
  "builtin:instances",
  "builtin:activity",
] as const;

const BUILTIN_KINDS = new Set<string>(BUILTIN_WIDGET_KINDS);
const CUSTOM_KIND_PATTERN = /^custom:(?!__proto__$)[A-Za-z0-9._-]{1,64}$/;
const CUSTOM_WIDGET_NAME_PATTERN = /^(?!__proto__$)[A-Za-z0-9._-]{1,64}$/;
const MAX_STATIC_BINDING_BYTES = 8 * 1024;
const MAX_RPC_BINDING_PARAMS_BYTES = 8 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`${path}.${key} is not allowed`);
    }
  }
}

function requireString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${path}.${key} must be a string`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${path}.${key} must be a string`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string, path: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${path}.${key} must be a boolean`);
  }
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return value;
}

function validateActor(value: unknown, path: string): WorkspaceActor {
  if (typeof value !== "string" || !ACTOR_PATTERN.test(value)) {
    throw new Error(`${path} createdBy is invalid`);
  }
  return value as WorkspaceActor;
}

export function isWorkspaceActor(value: unknown): value is WorkspaceActor {
  return typeof value === "string" && ACTOR_PATTERN.test(value);
}

function assertIntegerRange(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${path} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function validateGrid(value: unknown, path: string): WorkspaceGrid {
  const record = assertRecord(value, path);
  assertKnownKeys(record, ["x", "y", "w", "h"], path);
  const grid = {
    x: assertIntegerRange(record.x, `${path}.x`, 0, 11),
    y: assertIntegerRange(record.y, `${path}.y`, 0, 499),
    w: assertIntegerRange(record.w, `${path}.w`, 1, 12),
    h: assertIntegerRange(record.h, `${path}.h`, 1, 20),
  };
  if (grid.x + grid.w > 12) {
    throw new Error(`${path}.x + w must be 12 or less`);
  }
  return grid;
}

function assertJsonValue(value: unknown, path: string): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => assertJsonValue(entry, `${path}[${index}]`));
  }
  if (isRecord(value)) {
    const next: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = assertJsonValue(entry, `${path}.${key}`);
    }
    return next;
  }
  throw new Error(`${path} must be JSON-serializable`);
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function validateBinding(value: unknown, path: string): WorkspaceBinding {
  const record = assertRecord(value, path);
  const source = requireString(record, "source", path);
  if (source === "rpc") {
    assertKnownKeys(record, ["source", "method", "params"], path);
    const method = requireString(record, "method", path);
    if (!DATA_READ_RPC_ALLOWLIST.includes(method as (typeof DATA_READ_RPC_ALLOWLIST)[number])) {
      throw new Error(
        `${path}.method is not allowlisted; allowed: ${DATA_READ_RPC_ALLOWLIST.join(", ")}`,
      );
    }
    const params =
      record.params === undefined
        ? undefined
        : (assertJsonValue(
            assertRecord(record.params, `${path}.params`),
            `${path}.params`,
          ) as Record<string, JsonValue>);
    if (params !== undefined && serializedBytes(params) > MAX_RPC_BINDING_PARAMS_BYTES) {
      throw new Error(`${path}.params must serialize to 8 KB or less`);
    }
    return { source, method, ...(params !== undefined ? { params } : {}) };
  }
  if (source === "file") {
    assertKnownKeys(record, ["source", "path", "pointer"], path);
    const bindingPath = requireString(record, "path", path);
    normalizeWorkspaceDataLogicalPath(bindingPath);
    const pointer = optionalString(record, "pointer", path);
    return { source, path: bindingPath, ...(pointer !== undefined ? { pointer } : {}) };
  }
  if (source === "static") {
    assertKnownKeys(record, ["source", "value"], path);
    const jsonValue = assertJsonValue(record.value, `${path}.value`);
    if (serializedBytes(jsonValue) > MAX_STATIC_BINDING_BYTES) {
      throw new Error(`${path}.value must serialize to 8 KB or less`);
    }
    return { source, value: jsonValue };
  }
  throw new Error(`${path}.source is invalid`);
}

function validateBindingRecord(value: unknown, path: string): Record<string, WorkspaceBinding> {
  const record = assertRecord(value, path);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => {
      if (key === "__proto__" || !/^[A-Za-z0-9._-]{1,64}$/.test(key)) {
        throw new Error(`${path}.${key} binding id is invalid`);
      }
      return [key, validateBinding(entry, `${path}.${key}`)];
    }),
  );
}

function validateWidget(value: unknown, path: string): WorkspaceWidget {
  const record = assertRecord(value, path);
  assertKnownKeys(
    record,
    ["id", "kind", "title", "grid", "collapsed", "hidden", "createdBy", "bindings", "props"],
    path,
  );
  const id = requireString(record, "id", path);
  if (!WIDGET_ID_PATTERN.test(id)) {
    throw new Error(`${path}.id is invalid`);
  }
  const kind = requireString(record, "kind", path);
  if (!BUILTIN_KINDS.has(kind) && !CUSTOM_KIND_PATTERN.test(kind)) {
    // Name the alternatives: a caller that cannot see this file otherwise has to
    // guess the widget set one rejected write at a time.
    throw new Error(
      `${path}.kind is invalid: expected custom:<name> or one of ${BUILTIN_WIDGET_KINDS.join(", ")}`,
    );
  }
  const title = optionalString(record, "title", path);
  if (title !== undefined && title.length > 80) {
    throw new Error(`${path}.title must be 80 characters or fewer`);
  }
  const bindings =
    record.bindings === undefined
      ? undefined
      : validateBindingRecord(record.bindings, `${path}.bindings`);
  const props =
    record.props === undefined ? undefined : assertJsonValue(record.props, `${path}.props`);
  return {
    id,
    kind,
    ...(title !== undefined ? { title } : {}),
    grid: validateGrid(record.grid, `${path}.grid`),
    collapsed: requireBoolean(record, "collapsed", path),
    hidden: requireBoolean(record, "hidden", path),
    createdBy: validateActor(record.createdBy, `${path}.createdBy`),
    ...(bindings !== undefined ? { bindings } : {}),
    ...(props !== undefined ? { props } : {}),
  };
}

function validateTab(value: unknown, path: string): WorkspaceTab {
  const record = assertRecord(value, path);
  assertKnownKeys(record, ["slug", "title", "icon", "hidden", "createdBy", "widgets"], path);
  const slug = requireString(record, "slug", path);
  if (!TAB_SLUG_PATTERN.test(slug)) {
    throw new Error(`${path}.slug is invalid`);
  }
  const title = requireString(record, "title", path);
  if (title.length < 1 || title.length > 80) {
    throw new Error(`${path}.title must be 1-80 characters`);
  }
  const icon = optionalString(record, "icon", path);
  if (icon !== undefined && icon.length > 40) {
    throw new Error(`${path}.icon must be 40 characters or fewer`);
  }
  const widgets = requireArray(record.widgets, `${path}.widgets`);
  if (widgets.length > 24) {
    throw new Error(`${path}.widgets must contain at most 24 entries`);
  }
  return {
    slug,
    title,
    ...(icon !== undefined ? { icon } : {}),
    hidden: requireBoolean(record, "hidden", path),
    createdBy: validateActor(record.createdBy, `${path}.createdBy`),
    widgets: widgets.map((widget, index) => validateWidget(widget, `${path}.widgets[${index}]`)),
  };
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const WIDGET_FILE_PATH_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

function validateApprovedFiles(value: unknown, path: string): Record<string, string> {
  const record = assertRecord(value, path);
  const files: Record<string, string> = {};
  for (const [logicalPath, digest] of Object.entries(record)) {
    if (!WIDGET_FILE_PATH_PATTERN.test(logicalPath) || logicalPath.includes("..")) {
      throw new Error(`${path}.${logicalPath} is not a valid widget file path`);
    }
    if (typeof digest !== "string" || !SHA256_HEX_PATTERN.test(digest)) {
      throw new Error(`${path}.${logicalPath} must be a sha256 hex digest`);
    }
    files[logicalPath] = digest;
  }
  return files;
}

function validateRegistryEntry(value: unknown, path: string): WorkspaceWidgetRegistryEntry {
  const record = assertRecord(value, path);
  assertKnownKeys(
    record,
    ["status", "createdBy", "approvedBy", "approvedAt", "approvedFiles"],
    path,
  );
  const status = requireString(record, "status", path);
  if (status !== "pending" && status !== "approved" && status !== "rejected") {
    throw new Error(`${path}.status is invalid`);
  }
  const approvedBy =
    record.approvedBy === undefined
      ? undefined
      : validateActor(record.approvedBy, `${path}.approvedBy`);
  const approvedAt = optionalString(record, "approvedAt", path);
  const approvedFiles =
    record.approvedFiles === undefined
      ? undefined
      : validateApprovedFiles(record.approvedFiles, `${path}.approvedFiles`);
  return {
    status,
    createdBy: validateActor(record.createdBy, `${path}.createdBy`),
    ...(approvedBy !== undefined ? { approvedBy } : {}),
    ...(approvedAt !== undefined ? { approvedAt } : {}),
    ...(approvedFiles !== undefined ? { approvedFiles } : {}),
  };
}

function validateWidgetsRegistry(value: unknown): Record<string, WorkspaceWidgetRegistryEntry> {
  const record = assertRecord(value, "widgetsRegistry");
  return Object.fromEntries(
    Object.entries(record).map(([name, entry]) => {
      if (!CUSTOM_WIDGET_NAME_PATTERN.test(name)) {
        throw new Error(`widgetsRegistry.${name} name is invalid`);
      }
      return [name, validateRegistryEntry(entry, `widgetsRegistry.${name}`)];
    }),
  );
}

function validatePrefs(value: unknown, tabSlugs: Set<string>): WorkspaceDoc["prefs"] {
  const record = assertRecord(value, "prefs");
  assertKnownKeys(record, ["tabOrder"], "prefs");
  const tabOrder = requireArray(record.tabOrder, "prefs.tabOrder");
  const seen = new Set<string>();
  const order = tabOrder.map((entry, index) => {
    if (typeof entry !== "string" || !TAB_SLUG_PATTERN.test(entry)) {
      throw new Error(`prefs.tabOrder[${index}] is invalid`);
    }
    if (!tabSlugs.has(entry)) {
      throw new Error(`prefs.tabOrder[${index}] is not a tab slug`);
    }
    if (seen.has(entry)) {
      throw new Error(`prefs.tabOrder contains duplicate slug: ${entry}`);
    }
    seen.add(entry);
    return entry;
  });
  return { tabOrder: order };
}

function assertUniqueTabs(tabs: WorkspaceTab[]): Set<string> {
  const slugs = new Set<string>();
  for (const tab of tabs) {
    if (slugs.has(tab.slug)) {
      throw new Error(`duplicate tab slug: ${tab.slug}`);
    }
    slugs.add(tab.slug);
  }
  return slugs;
}

function assertUniqueWidgets(tabs: WorkspaceTab[]): void {
  const ids = new Set<string>();
  for (const tab of tabs) {
    for (const widget of tab.widgets) {
      if (ids.has(widget.id)) {
        throw new Error(`duplicate widget id: ${widget.id}`);
      }
      ids.add(widget.id);
    }
  }
}

export function validateWorkspaceDoc(value: unknown): WorkspaceDoc {
  const record = assertRecord(value, "workspaces");
  assertKnownKeys(
    record,
    ["schemaVersion", "workspaceVersion", "tabs", "widgetsRegistry", "prefs"],
    "workspaces",
  );
  if (record.schemaVersion !== CURRENT_WORKSPACE_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${CURRENT_WORKSPACE_SCHEMA_VERSION}`);
  }
  const workspaceVersion = assertIntegerRange(
    record.workspaceVersion,
    "workspaceVersion",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const rawTabs = requireArray(record.tabs, "tabs");
  if (rawTabs.length > 32) {
    throw new Error("tabs must contain at most 32 entries");
  }
  const tabs = rawTabs.map((tab, index) => validateTab(tab, `tabs[${index}]`));
  const tabSlugs = assertUniqueTabs(tabs);
  assertUniqueWidgets(tabs);
  return {
    schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
    workspaceVersion,
    tabs,
    widgetsRegistry: validateWidgetsRegistry(record.widgetsRegistry),
    prefs: validatePrefs(record.prefs, tabSlugs),
  };
}

export function migrateWorkspaceDoc(value: unknown): { doc: WorkspaceDoc; changed: boolean } {
  const record = assertRecord(value, "workspaces");
  const schemaVersion = record.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    throw new Error("schemaVersion must be an integer");
  }
  if (schemaVersion > CURRENT_WORKSPACE_SCHEMA_VERSION) {
    throw new Error(`unsupported future workspace schemaVersion: ${schemaVersion}`);
  }
  if (schemaVersion < CURRENT_WORKSPACE_SCHEMA_VERSION) {
    throw new Error(`unsupported old workspace schemaVersion: ${schemaVersion}`);
  }
  return { doc: validateWorkspaceDoc(record), changed: false };
}
