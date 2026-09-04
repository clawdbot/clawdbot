import { SANDBOX_HOST_PATH } from "../agents/sandbox-host.js";
import type { PluginBoardWidgetContentKind } from "./board-widget-content-kind.types.js";
import { PluginDashboardDeclarationError } from "./dashboard-capabilities.js";
import type {
  PluginBoardWidgetContentKindRegistration,
  PluginRecord,
  PluginRegistry,
} from "./registry-types.js";

const CONTENT_KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const SURFACE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
const RESERVED_CONTENT_KINDS = new Set(["html", "mcp-app", "plugin"]);

function fail(pluginId: string, message: string): never {
  throw new PluginDashboardDeclarationError(
    `invalid board widget content kind for plugin ${JSON.stringify(pluginId)}: ${message}`,
  );
}

function isGatewayLocalPath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\");
}

function isCanonicalPublicResourcePath(value: string): boolean {
  try {
    // Public readers match URL pathnames, and the proxy owns its route before reader dispatch.
    return value !== SANDBOX_HOST_PATH && new URL(value, "http://localhost").pathname === value;
  } catch {
    return false;
  }
}

/** Validates and publishes one runtime board-widget content kind. */
function registerPluginBoardWidgetContentKind(params: {
  record: PluginRecord;
  registry: PluginRegistry;
  definition: PluginBoardWidgetContentKind;
}): void {
  const { definition, record, registry } = params;
  const kind = typeof definition.kind === "string" ? definition.kind.trim() : "";
  const label = typeof definition.label === "string" ? definition.label.trim() : "";
  const surface =
    typeof definition.resources?.surface === "string" ? definition.resources.surface.trim() : "";
  const paths = definition.resources?.paths;
  if (!CONTENT_KIND_PATTERN.test(kind) || RESERVED_CONTENT_KINDS.has(kind)) {
    fail(record.id, `kind ${JSON.stringify(kind)} is invalid or reserved`);
  }
  if (!label || label.length > 80) {
    fail(record.id, "label must contain 1-80 characters");
  }
  if (!SURFACE_PATTERN.test(surface)) {
    fail(record.id, `resource surface ${JSON.stringify(surface)} is invalid`);
  }
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.length > 8 ||
    paths.some(
      (resourcePath) =>
        typeof resourcePath !== "string" ||
        resourcePath.length > 256 ||
        !isGatewayLocalPath(resourcePath),
    ) ||
    new Set(paths).size !== paths.length
  ) {
    fail(record.id, "resource paths must be 1-8 unique gateway-local absolute paths");
  }
  if (
    typeof definition.validateSource !== "function" ||
    typeof definition.composeDocument !== "function"
  ) {
    fail(record.id, "validateSource and composeDocument callbacks are required");
  }
  const publicReader = definition.resources.readPublicResource;
  if (publicReader !== undefined && typeof publicReader !== "function") {
    fail(record.id, "readPublicResource must be a function");
  }
  if (publicReader && paths.some((resourcePath) => !isCanonicalPublicResourcePath(resourcePath))) {
    fail(
      record.id,
      `public resource paths must be canonical URL pathnames and cannot use ${SANDBOX_HOST_PATH}`,
    );
  }
  for (const registered of registry.boardWidgetContentKinds.values()) {
    const existing = registered.definition.resources;
    if (
      (publicReader || existing.readPublicResource) &&
      existing.paths.some((entry) => paths.includes(entry))
    ) {
      fail(record.id, "public resource paths must be unique across registered content kinds");
    }
  }
  if (registry.boardWidgetContentKinds.has(kind)) {
    fail(record.id, `duplicate kind ${JSON.stringify(kind)}`);
  }
  const pluginKind = `${record.id}:${kind}`;
  if (!/^[a-z0-9][a-z0-9-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}$/u.test(pluginKind)) {
    fail(record.id, `persisted kind ${JSON.stringify(pluginKind)} is invalid`);
  }
  registry.boardWidgetContentKinds.set(kind, {
    pluginId: record.id,
    pluginKind,
    definition: {
      ...definition,
      kind,
      label,
      resources: { ...definition.resources, surface, paths: [...paths] },
    },
  });
}

export function createPluginBoardWidgetContentKindRegistrar(registry: PluginRegistry) {
  return (record: PluginRecord, definition: PluginBoardWidgetContentKind) =>
    registerPluginBoardWidgetContentKind({ record, registry, definition });
}

export function resolveBoardWidgetContentKind(
  registry: PluginRegistry | null | undefined,
  kind: string,
): PluginBoardWidgetContentKindRegistration | undefined {
  return registry?.boardWidgetContentKinds.get(kind);
}

export function resolveBoardWidgetContentKindByPluginKind(
  registry: PluginRegistry | null | undefined,
  pluginKind: string,
): PluginBoardWidgetContentKindRegistration | undefined {
  if (!registry) {
    return undefined;
  }
  for (const registration of registry.boardWidgetContentKinds.values()) {
    if (registration.pluginKind === pluginKind) {
      return registration;
    }
  }
  return undefined;
}

export function listBoardWidgetContentKinds(registry: PluginRegistry | null | undefined): string[] {
  return [...(registry?.boardWidgetContentKinds.keys() ?? [])].toSorted();
}

/** Resolves registration resource paths below one connection-scoped plugin capability URL. */
export function resolveBoardWidgetContentKindResourceUrls(
  registration: PluginBoardWidgetContentKindRegistration,
  scopedHostUrl: string,
): Readonly<Record<string, string>> | undefined {
  try {
    const scoped = new URL(scopedHostUrl);
    const prefix = scoped.pathname.replace(/\/+$/u, "");
    if (!/^\/__openclaw__\/cap\/[^/]+$/u.test(prefix)) {
      return undefined;
    }
    return Object.fromEntries(
      registration.definition.resources.paths.map((resourcePath) => {
        const url = new URL(scoped.toString());
        url.pathname = `${prefix}${resourcePath}`;
        url.search = "";
        url.hash = "";
        return [resourcePath, url.toString()];
      }),
    );
  } catch {
    return undefined;
  }
}
