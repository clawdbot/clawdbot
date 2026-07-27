import { createHash } from "node:crypto";
import type { Selectable } from "kysely";
import type {
  BoardMcpAppDescriptor,
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
import { createBoardDeclaredSummary } from "./board-store.js";

export type SelectedBoardTabRow = Selectable<BoardTabRow>;
export type SelectedBoardWidgetRow = Selectable<BoardWidgetRow>;

const BOARD_GRANT_SEMANTICS_VERSION = 2;

type ParsedBoardManifest = {
  declared?: BoardWidgetDeclared;
  declarationInvalid?: true;
  grantSemanticsVersion?: number;
  presentation?: BoardWidget["presentation"];
  heightMode?: BoardWidget["heightMode"];
  mcpAppInteractive?: boolean;
  mcpAppInstanceId?: string;
};

type ParsedPluginContent = {
  pluginKind: string;
  props?: Record<string, unknown>;
};

export function parseManifest(value: string): ParsedBoardManifest {
  const parsed = JSON.parse(value) as {
    netOrigins?: unknown;
    tools?: unknown;
    grantSemanticsVersion?: unknown;
    presentation?: unknown;
    heightMode?: unknown;
    mcpAppInteractive?: unknown;
    mcpAppInstanceId?: unknown;
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
  const presentation =
    parsed.presentation === "card" ||
    parsed.presentation === "full-bleed" ||
    parsed.presentation === "frameless"
      ? parsed.presentation
      : undefined;
  const heightMode =
    parsed.heightMode === "auto" || parsed.heightMode === "fixed" ? parsed.heightMode : undefined;
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
      ...(mcpAppInteractive !== undefined ? { mcpAppInteractive } : {}),
      ...(mcpAppInstanceId ? { mcpAppInstanceId } : {}),
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
  mcpAppAuthority?: { interactive: boolean; instanceId: string },
  widgetOptions?: Pick<BoardWidget, "presentation" | "heightMode">,
): string {
  return JSON.stringify({
    ...declared,
    ...(widgetOptions?.presentation ? { presentation: widgetOptions.presentation } : {}),
    ...(widgetOptions?.heightMode ? { heightMode: widgetOptions.heightMode } : {}),
    ...(grantState === "granted" ? { grantSemanticsVersion: BOARD_GRANT_SEMANTICS_VERSION } : {}),
    ...(mcpAppAuthority
      ? {
          mcpAppInteractive: mcpAppAuthority.interactive,
          mcpAppInstanceId: mcpAppAuthority.instanceId,
        }
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
      ? { interactive: params.content.interactive, instanceId: viewGeneration }
      : undefined,
    frame,
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

export function updateManifestHeightMode(
  value: string,
  heightMode: NonNullable<BoardWidget["heightMode"]>,
): string {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, heightMode });
}

export function effectiveGrantState(
  grantState: BoardWidget["grantState"],
  manifest: ParsedBoardManifest,
): BoardWidget["grantState"] {
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
  return JSON.parse(value) as ParsedPluginContent;
}

export function rowToTab(row: SelectedBoardTabRow): BoardTab {
  return {
    tabId: row.tab_id,
    title: row.title,
    position: row.position,
    chatDock: row.chat_dock as BoardTab["chatDock"],
  };
}

export function rowToWidget(row: SelectedBoardWidgetRow): BoardWidget {
  const manifest = parseManifest(row.manifest);
  const declared = manifest.declared;
  const declaredSummary = createBoardDeclaredSummary(declared);
  const pluginContent =
    row.content_kind === "plugin" && row.descriptor_json !== null
      ? parsePluginContent(row.descriptor_json)
      : undefined;
  const instanceId =
    row.content_kind === "mcp-app" ? manifest.mcpAppInstanceId : row.view_generation;
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
          ...(pluginContent.props !== undefined ? { props: pluginContent.props } : {}),
        }
      : {}),
    sizeW: row.size_w,
    sizeH: row.size_h,
    position: row.position,
    grantState: effectiveGrantState(row.grant_state as BoardWidget["grantState"], manifest),
    revision: row.revision,
    ...(instanceId ? { instanceId } : {}),
    ...(declaredSummary ? { declaredSummary } : {}),
    ...(declared ? { declared } : {}),
  };
}
