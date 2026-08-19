import { createHash } from "node:crypto";
import type { Selectable } from "kysely";
import type {
  BoardMcpAppDescriptor,
  BoardSnapshot,
  BoardTab,
  BoardWidget,
  BoardWidgetDeclared,
  BoardWidgetMaterializedPutParams,
} from "../../packages/gateway-protocol/src/index.js";
import type {
  BoardTabs as BoardTabRow,
  BoardWidgets as BoardWidgetRow,
} from "../state/openclaw-agent-db.generated.js";
import { normalizeBoardWidgetDeclared } from "./board-capabilities.js";
import { BoardValidationError } from "./board-layout.js";
import {
  createBoardDeclaredSummary,
  resolveBoardWidgetPutParams,
  type BoardWidgetHtmlViewMetadata,
  type BoardWidgetNameIdentityMarker,
  type BoardWidgetRegisteredDocument,
} from "./board-store.js";

export type SelectedBoardTabRow = Selectable<BoardTabRow>;
export type SelectedBoardWidgetRow = Selectable<BoardWidgetRow>;
export type SelectedBoardWidgetSnapshotRow = Omit<SelectedBoardWidgetRow, "html">;

export const BOARD_WIDGET_SNAPSHOT_COLUMNS = [
  "session_key",
  "name",
  "tab_id",
  "title",
  "content_kind",
  "descriptor_json",
  "sha256",
  "view_generation",
  "revision",
  "size_w",
  "size_h",
  "position",
  "manifest",
  "grant_state",
  "granted_sha",
  "created_by",
  "created_at",
  "updated_at",
] as const;

const BOARD_GRANT_SEMANTICS_VERSION = 2;

type ParsedBoardManifest = {
  declared?: BoardWidgetDeclared;
  declarationInvalid?: true;
  grantSemanticsVersion?: number;
  presentation?: BoardWidget["presentation"];
  heightMode?: BoardWidget["heightMode"];
  nameIdentity?: BoardWidgetNameIdentityMarker;
  nameIdentityInvalid?: true;
  mcpAppInteractive?: boolean;
  mcpAppInstanceId?: string;
  registeredInstanceId?: string;
};

type ParsedTrustedPluginContent = {
  pluginKind: string;
  props?: Record<string, unknown>;
};
type ParsedRegisteredPluginContent = {
  pluginKind: string;
  source: string;
};
type ParsedPluginContent = ParsedTrustedPluginContent | ParsedRegisteredPluginContent;

export function parseManifest(value: string): ParsedBoardManifest {
  const parsed = JSON.parse(value) as {
    netOrigins?: unknown;
    tools?: unknown;
    grantSemanticsVersion?: unknown;
    presentation?: unknown;
    heightMode?: unknown;
    nameIdentity?: unknown;
    mcpAppInteractive?: unknown;
    mcpAppInstanceId?: unknown;
    registeredInstanceId?: unknown;
  };
  const netOrigins = Array.isArray(parsed.netOrigins)
    ? parsed.netOrigins.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const tools = Array.isArray(parsed.tools)
    ? parsed.tools.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const mcpAppInteractive =
    typeof parsed.mcpAppInteractive === "boolean" ? parsed.mcpAppInteractive : undefined;
  const mcpAppInstanceId =
    typeof parsed.mcpAppInstanceId === "string" && /^[a-f0-9]{32}$/u.test(parsed.mcpAppInstanceId)
      ? parsed.mcpAppInstanceId
      : undefined;
  const registeredInstanceId =
    typeof parsed.registeredInstanceId === "string" &&
    /^[a-f0-9]{32}$/u.test(parsed.registeredInstanceId)
      ? parsed.registeredInstanceId
      : undefined;
  const presentation =
    parsed.presentation === "card" ||
    parsed.presentation === "full-bleed" ||
    parsed.presentation === "frameless"
      ? parsed.presentation
      : undefined;
  const heightMode =
    parsed.heightMode === "auto" || parsed.heightMode === "fixed" ? parsed.heightMode : undefined;
  const nameIdentityPresent = Object.hasOwn(parsed, "nameIdentity");
  const nameIdentity = (() => {
    if (
      !parsed.nameIdentity ||
      typeof parsed.nameIdentity !== "object" ||
      Array.isArray(parsed.nameIdentity)
    ) {
      return undefined;
    }
    const identity = parsed.nameIdentity as {
      kind?: unknown;
      source?: unknown;
      key?: unknown;
    };
    if (identity.kind === "explicit") {
      return { kind: "explicit" as const };
    }
    if (
      identity.kind === "generated" &&
      identity.source === "show_widget" &&
      typeof identity.key === "string" &&
      /^[a-f0-9]{64}$/u.test(identity.key)
    ) {
      return { kind: "generated" as const, source: "show_widget" as const, key: identity.key };
    }
    return undefined;
  })();
  try {
    const declared = normalizeBoardWidgetDeclared({
      ...(netOrigins?.length ? { netOrigins } : {}),
      ...(tools?.length ? { tools } : {}),
    });
    return {
      ...(declared ? { declared } : {}),
      ...(parsed.grantSemanticsVersion === BOARD_GRANT_SEMANTICS_VERSION
        ? { grantSemanticsVersion: BOARD_GRANT_SEMANTICS_VERSION }
        : {}),
      ...(presentation ? { presentation } : {}),
      ...(heightMode ? { heightMode } : {}),
      ...(nameIdentity ? { nameIdentity } : {}),
      ...(!nameIdentity && nameIdentityPresent ? { nameIdentityInvalid: true as const } : {}),
      ...(mcpAppInteractive !== undefined ? { mcpAppInteractive } : {}),
      ...(mcpAppInstanceId ? { mcpAppInstanceId } : {}),
      ...(registeredInstanceId ? { registeredInstanceId } : {}),
    };
  } catch (error) {
    if (error instanceof BoardValidationError) {
      // Unsafe manifests persisted before declaration validation lose their
      // entire authority; retaining a partial old grant would widen access.
      return { declarationInvalid: true };
    }
    throw error;
  }
}

export function serializeManifest(
  declared: BoardWidgetDeclared | undefined,
  grantState: BoardWidget["grantState"],
  frameAuthority?:
    | { kind: "mcp-app"; interactive: boolean; instanceId: string }
    | { kind: "registered"; instanceId: string },
  widgetOptions?: Pick<BoardWidget, "presentation" | "heightMode">,
  nameIdentity?: BoardWidgetNameIdentityMarker,
): string {
  return JSON.stringify({
    ...declared,
    ...(widgetOptions?.presentation ? { presentation: widgetOptions.presentation } : {}),
    ...(widgetOptions?.heightMode ? { heightMode: widgetOptions.heightMode } : {}),
    ...(nameIdentity ? { nameIdentity } : {}),
    ...(grantState === "granted" ? { grantSemanticsVersion: BOARD_GRANT_SEMANTICS_VERSION } : {}),
    ...(frameAuthority?.kind === "mcp-app"
      ? {
          mcpAppInteractive: frameAuthority.interactive,
          mcpAppInstanceId: frameAuthority.instanceId,
        }
      : {}),
    ...(frameAuthority?.kind === "registered"
      ? { registeredInstanceId: frameAuthority.instanceId }
      : {}),
  });
}

export function createBoardWidgetContentFields(
  params: BoardWidgetMaterializedPutParams,
  // Effective frame options come from the materialized widget, not the raw put
  // params: re-pins that omit them must keep the inherited persisted values.
  frame: Pick<BoardWidget, "presentation" | "heightMode">,
  revision: number,
  grantState: BoardWidget["grantState"],
  viewGeneration: string,
  now: number,
) {
  const manifest = serializeManifest(
    params.declared,
    grantState,
    params.content.kind === "mcp-app"
      ? { kind: "mcp-app", interactive: params.content.interactive, instanceId: viewGeneration }
      : params.content.kind === "registered"
        ? { kind: "registered", instanceId: viewGeneration }
        : undefined,
    frame,
    params.generatedIdentity
      ? {
          kind: "generated",
          source: params.generatedIdentity.source,
          key: params.generatedIdentity.key,
        }
      : { kind: "explicit" },
  );
  if (params.content.kind === "html") {
    const sha256 = createHash("sha256").update(params.content.html).digest("hex");
    return {
      content_kind: "html",
      html: Buffer.from(params.content.html, "utf8"),
      descriptor_json: null,
      sha256,
      view_generation: viewGeneration,
      revision,
      manifest,
      grant_state: grantState,
      granted_sha: grantState === "granted" ? sha256 : null,
      updated_at: now,
    };
  }
  if (params.content.kind === "plugin") {
    const descriptorJson = JSON.stringify({
      pluginKind: params.content.pluginKind,
      ...(params.content.props !== undefined ? { props: params.content.props } : {}),
    });
    return {
      content_kind: "plugin",
      html: null,
      descriptor_json: descriptorJson,
      sha256: createHash("sha256").update(descriptorJson).digest("hex"),
      view_generation: null,
      revision,
      manifest,
      grant_state: "none",
      granted_sha: null,
      updated_at: now,
    };
  }
  if (params.content.kind === "registered") {
    const descriptorJson = JSON.stringify({
      pluginKind: params.content.pluginKind,
      source: params.content.source,
    });
    const sha256 = createHash("sha256").update(params.content.source).digest("hex");
    return {
      content_kind: "plugin",
      html: null,
      descriptor_json: descriptorJson,
      sha256,
      view_generation: null,
      revision,
      manifest,
      grant_state: grantState,
      granted_sha: grantState === "granted" ? sha256 : null,
      updated_at: now,
    };
  }
  const descriptorJson = JSON.stringify(params.content.descriptor);
  const sha256 = createHash("sha256").update(descriptorJson).digest("hex");
  return {
    content_kind: "mcp-app",
    html: null,
    descriptor_json: descriptorJson,
    sha256,
    view_generation: null,
    revision,
    manifest,
    grant_state: grantState,
    granted_sha: grantState === "granted" ? sha256 : null,
    updated_at: now,
  };
}

export function resolveSqliteBoardWidgetPutParams(
  snapshot: BoardSnapshot,
  params: BoardWidgetMaterializedPutParams,
  rows: readonly SelectedBoardWidgetSnapshotRow[],
): BoardWidgetMaterializedPutParams {
  const identities = new Map<string, BoardWidgetNameIdentityMarker>();
  for (const row of rows) {
    const manifest = parseManifest(row.manifest);
    const nameIdentity =
      manifest.nameIdentity ??
      (manifest.nameIdentityInvalid ? { kind: "invalid" as const } : undefined);
    if (nameIdentity) {
      identities.set(row.name, nameIdentity);
    }
  }
  return resolveBoardWidgetPutParams(snapshot, params, identities);
}

export function updateManifestHeightMode(
  value: string,
  heightMode: NonNullable<BoardWidget["heightMode"]>,
): string {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, heightMode });
}

export function effectiveGrantState(
  storedGrantState: string,
  manifest: ParsedBoardManifest,
): BoardWidget["grantState"] {
  const grantState: BoardWidget["grantState"] =
    storedGrantState === "pending" ||
    storedGrantState === "granted" ||
    storedGrantState === "rejected"
      ? storedGrantState
      : "none";
  if (manifest.declarationInvalid || (!manifest.declared && manifest.mcpAppInteractive !== true)) {
    // Losing an invalid legacy declaration removes authority, never an
    // operator's explicit rejection of the widget document itself.
    return grantState === "rejected" ? "rejected" : "none";
  }
  if (
    grantState === "granted" &&
    manifest.grantSemanticsVersion !== BOARD_GRANT_SEMANTICS_VERSION
  ) {
    // Older stores rebound granted_sha after byte changes. Their hashes cannot
    // prove operator approval under the byte-frozen capability contract.
    return "pending";
  }
  return grantState;
}

export function parseDescriptor(value: string): BoardMcpAppDescriptor {
  return JSON.parse(value) as BoardMcpAppDescriptor;
}

export function parsePluginContent(value: string): ParsedPluginContent {
  const parsed = JSON.parse(value) as Partial<ParsedRegisteredPluginContent> &
    Partial<ParsedTrustedPluginContent>;
  if (typeof parsed.pluginKind !== "string") {
    throw new BoardValidationError("invalid_operation", "board plugin widget kind is invalid");
  }
  return typeof parsed.source === "string"
    ? { pluginKind: parsed.pluginKind, source: parsed.source }
    : {
        pluginKind: parsed.pluginKind,
        ...(parsed.props !== undefined ? { props: parsed.props } : {}),
      };
}

export function rowToRegisteredDocument(
  row: Pick<
    SelectedBoardWidgetRow,
    | "content_kind"
    | "descriptor_json"
    | "title"
    | "revision"
    | "sha256"
    | "grant_state"
    | "manifest"
  >,
): BoardWidgetRegisteredDocument | undefined {
  if (row.content_kind !== "plugin" || row.descriptor_json === null) {
    return undefined;
  }
  const content = parsePluginContent(row.descriptor_json);
  const manifest = parseManifest(row.manifest);
  if (!("source" in content) || !manifest.registeredInstanceId) {
    return undefined;
  }
  return {
    pluginKind: content.pluginKind,
    source: content.source,
    ...(row.title !== null ? { title: row.title } : {}),
    revision: row.revision,
    sha256: row.sha256,
    viewGeneration: manifest.registeredInstanceId,
    grantState: effectiveGrantState(row.grant_state, manifest),
    ...(manifest.declared ? { declared: manifest.declared } : {}),
  };
}

export function rowToTab(row: SelectedBoardTabRow): BoardTab {
  return {
    tabId: row.tab_id,
    title: row.title,
    position: row.position,
    chatDock: row.chat_dock as BoardTab["chatDock"],
  };
}

export function rowToWidget(
  row: SelectedBoardWidgetSnapshotRow,
  manifest: ReturnType<typeof parseManifest> = parseManifest(row.manifest),
): BoardWidget {
  const declared = manifest.declared;
  const declaredSummary = createBoardDeclaredSummary(declared);
  const pluginContent =
    row.content_kind === "plugin" && row.descriptor_json !== null
      ? parsePluginContent(row.descriptor_json)
      : undefined;
  const instanceId =
    row.content_kind === "mcp-app"
      ? manifest.mcpAppInstanceId
      : pluginContent && "source" in pluginContent
        ? manifest.registeredInstanceId
        : row.view_generation;
  return {
    name: row.name,
    tabId: row.tab_id,
    ...(row.title !== null ? { title: row.title } : {}),
    contentKind: row.content_kind as BoardWidget["contentKind"],
    ...(manifest.presentation ? { presentation: manifest.presentation } : {}),
    ...(manifest.heightMode ? { heightMode: manifest.heightMode } : {}),
    ...(pluginContent
      ? {
          pluginKind: pluginContent.pluginKind,
          ...("props" in pluginContent && pluginContent.props !== undefined
            ? { props: pluginContent.props }
            : {}),
        }
      : {}),
    sizeW: row.size_w,
    sizeH: row.size_h,
    position: row.position,
    grantState: effectiveGrantState(row.grant_state, manifest),
    revision: row.revision,
    ...(instanceId ? { instanceId } : {}),
    ...(declaredSummary ? { declaredSummary } : {}),
    ...(declared ? { declared } : {}),
  };
}

export function rowToHtmlViewMetadata(
  row: Pick<
    SelectedBoardWidgetSnapshotRow,
    "content_kind" | "revision" | "sha256" | "view_generation" | "grant_state"
  >,
  manifest: ReturnType<typeof parseManifest>,
): BoardWidgetHtmlViewMetadata | undefined {
  const viewGeneration =
    row.content_kind === "html" ? row.view_generation : manifest.registeredInstanceId;
  if (viewGeneration === null || viewGeneration === undefined) {
    return undefined;
  }
  const declared = manifest.declared;
  return {
    revision: row.revision,
    sha256: row.sha256,
    viewGeneration,
    grantState: effectiveGrantState(row.grant_state, manifest),
    ...(declared ? { declared } : {}),
  };
}
