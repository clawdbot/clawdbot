import { createHash } from "node:crypto";
import type {
  BoardMcpAppDescriptor,
  BoardOp,
  BoardSnapshot,
  BoardWidgetMaterializedPutParams,
  BoardWidgetDeclared,
  BoardWidgetGeneratedIdentity,
  BoardWidgetPutResult,
} from "../../packages/gateway-protocol/src/index.js";
import { boardDeclarationIsSubset, normalizeBoardWidgetDeclared } from "./board-capabilities.js";
import {
  BOARD_SIZE_PRESETS,
  BoardValidationError,
  insertBoardWidget,
  normalizeBoardLayout,
  type BoardSize,
} from "./board-layout.js";

export type BoardWidgetHtmlDocument = {
  html: string;
  revision: number;
  sha256: string;
  viewGeneration: string;
  grantState: "none" | "pending" | "granted" | "rejected";
  declared?: BoardWidgetDeclared;
  resourceOrigins?: string[];
};
export type BoardWidgetHtmlViewMetadata = Omit<BoardWidgetHtmlDocument, "html">;
export type BoardWidgetRegisteredDocument = {
  pluginKind: string;
  source: string;
  title?: string;
  revision: number;
  sha256: string;
  viewGeneration: string;
  grantState: "none" | "pending" | "granted" | "rejected";
  declared?: BoardWidgetDeclared;
};
export type BoardWidgetMcpAppDocument = {
  descriptor: BoardMcpAppDescriptor;
  revision: number;
  instanceId: string;
  grantState: "none" | "pending" | "granted" | "rejected";
  declaredTools: string[];
  interactive: boolean;
};
export type BoardWidgetDocument =
  | BoardWidgetHtmlDocument
  | BoardWidgetRegisteredDocument
  | BoardWidgetMcpAppDocument;
export type BoardSnapshotWithHtmlViewMetadata = {
  snapshot: BoardSnapshot;
  htmlViewMetadata: ReadonlyMap<string, BoardWidgetHtmlViewMetadata>;
};

export type BoardSessionTarget = { sessionKey: string; agentId?: string };

export interface BoardStore {
  getSnapshot(target: BoardSessionTarget): BoardSnapshot;
  getSnapshotWithHtmlViewMetadata(target: BoardSessionTarget): BoardSnapshotWithHtmlViewMetadata;
  applyOps(target: BoardSessionTarget, ops: readonly BoardOp[]): BoardSnapshot;
  putWidget(params: BoardWidgetMaterializedPutParams): BoardWidgetPutResult;
  grant(
    target: BoardSessionTarget,
    name: string,
    decision: "granted" | "rejected",
    revision: number,
    instanceId?: string,
  ): BoardSnapshot;
  readWidgetHtml(target: BoardSessionTarget, name: string): BoardWidgetHtmlDocument | undefined;
  readWidgetRegistered(
    target: BoardSessionTarget,
    name: string,
  ): BoardWidgetRegisteredDocument | undefined;
  readWidgetMcpApp(target: BoardSessionTarget, name: string): BoardWidgetMcpAppDocument | undefined;
}

const BOARD_MAX_WIDGETS = 48;
const BOARD_MAX_WIDGET_HTML_BYTES = 256 * 1024;
const BOARD_MAX_WIDGET_PLUGIN_PROPS_BYTES = 8 * 1024;
type BoardWidgetGeneratedIdentityMarker = Pick<BoardWidgetGeneratedIdentity, "source" | "key"> & {
  kind: "generated";
};
export type BoardWidgetNameIdentityMarker =
  | { kind: "explicit" }
  | BoardWidgetGeneratedIdentityMarker
  | { kind: "invalid" };

export function cloneBoardSnapshot(snapshot: BoardSnapshot): BoardSnapshot {
  return {
    sessionKey: snapshot.sessionKey,
    revision: snapshot.revision,
    tabs: snapshot.tabs.map((tab) => ({ ...tab })),
    widgets: snapshot.widgets.map((widget) => ({
      ...widget,
      ...(widget.props !== undefined ? { props: structuredClone(widget.props) } : {}),
      ...(widget.declaredSummary !== undefined
        ? { declaredSummary: [...widget.declaredSummary] }
        : {}),
      ...(widget.declared !== undefined
        ? {
            declared: {
              ...(widget.declared.netOrigins
                ? { netOrigins: [...widget.declared.netOrigins] }
                : {}),
              ...(widget.declared.tools ? { tools: [...widget.declared.tools] } : {}),
            },
          }
        : {}),
    })),
  };
}

export function createBoardDeclaredSummary(
  declared: BoardWidgetMaterializedPutParams["declared"],
): string[] | undefined {
  const lines = [
    ...(declared?.netOrigins ?? []).map((origin) => `Network access: ${origin}`),
    ...(declared?.tools ?? []).map((tool) => `Tool access: ${tool}`),
  ];
  return lines.length > 0 ? lines : undefined;
}

function generatedIdentityMatches(
  left: BoardWidgetNameIdentityMarker | undefined,
  right: BoardWidgetGeneratedIdentityMarker,
): boolean {
  return left?.kind === "generated" && left.source === right.source && left.key === right.key;
}

export function resolveBoardWidgetPutParams(
  prior: BoardSnapshot,
  params: BoardWidgetMaterializedPutParams,
  nameIdentities: ReadonlyMap<string, BoardWidgetNameIdentityMarker>,
): BoardWidgetMaterializedPutParams {
  const generatedIdentity = params.generatedIdentity;
  if (!generatedIdentity) {
    return params;
  }
  if (generatedIdentity.fallbackName === params.name) {
    throw new BoardValidationError(
      "invalid_operation",
      "generated widget fallback name must differ from its preferred name",
    );
  }
  const marker: BoardWidgetGeneratedIdentityMarker = {
    kind: "generated",
    source: generatedIdentity.source,
    key: generatedIdentity.key,
  };
  const existingGenerated = prior.widgets.find((widget) =>
    generatedIdentityMatches(nameIdentities.get(widget.name), marker),
  );
  if (existingGenerated) {
    return { ...params, name: existingGenerated.name };
  }

  const preferred = prior.widgets.find((widget) => widget.name === params.name);
  if (!preferred) {
    return params;
  }

  const fallback = prior.widgets.find((widget) => widget.name === generatedIdentity.fallbackName);
  if (fallback) {
    throw new BoardValidationError(
      "conflict",
      `generated widget fallback name is already in use: ${generatedIdentity.fallbackName}`,
    );
  }
  return { ...params, name: generatedIdentity.fallbackName };
}

export function normalizeBoardWidgetPutParams(
  params: BoardWidgetMaterializedPutParams,
  sessionKey = params.sessionKey,
): BoardWidgetMaterializedPutParams {
  const declared = normalizeBoardWidgetDeclared(params.declared);
  const canonical = { ...params, sessionKey };
  if (declared) {
    canonical.declared = declared;
  } else {
    delete canonical.declared;
  }
  return canonical;
}

export function createBoardWidgetPutResult(
  snapshot: BoardSnapshot,
  resolvedWidgetName: string,
): BoardWidgetPutResult {
  return { ...cloneBoardSnapshot(snapshot), resolvedWidgetName };
}

function validatePluginContent(params: BoardWidgetMaterializedPutParams): void {
  if (params.content.kind !== "plugin") {
    return;
  }
  if (params.declared !== undefined) {
    throw new BoardValidationError(
      "invalid_operation",
      "trusted plugin widgets do not accept sandbox capability declarations",
    );
  }
  const propsBytes = Buffer.byteLength(JSON.stringify(params.content.props ?? {}), "utf8");
  if (propsBytes > BOARD_MAX_WIDGET_PLUGIN_PROPS_BYTES) {
    throw new BoardValidationError(
      "invalid_operation",
      `board plugin widget props exceed ${BOARD_MAX_WIDGET_PLUGIN_PROPS_BYTES} UTF-8 bytes`,
    );
  }
}

function validateRegisteredContent(params: BoardWidgetMaterializedPutParams): void {
  if (params.content.kind !== "registered") {
    return;
  }
  if (Buffer.byteLength(params.content.source, "utf8") > BOARD_MAX_WIDGET_HTML_BYTES) {
    throw new BoardValidationError(
      "invalid_operation",
      `board registered widget source exceeds ${BOARD_MAX_WIDGET_HTML_BYTES} UTF-8 bytes`,
    );
  }
}

export function createBoardWidgetPutSnapshot(
  prior: BoardSnapshot,
  params: BoardWidgetMaterializedPutParams,
  context: {
    grantScopeMatches: boolean;
    grantedSha256?: string;
    instanceId: string;
  },
): BoardSnapshot {
  validatePluginContent(params);
  validateRegisteredContent(params);
  if (
    params.content.kind === "html" &&
    Buffer.byteLength(params.content.html, "utf8") > BOARD_MAX_WIDGET_HTML_BYTES
  ) {
    throw new BoardValidationError(
      "invalid_operation",
      `board widget HTML exceeds ${BOARD_MAX_WIDGET_HTML_BYTES} UTF-8 bytes`,
    );
  }
  let layout = normalizeBoardLayout(prior);
  if (layout.tabs.length === 0) {
    layout.tabs.push({ tabId: "main", title: "Main", position: 0, chatDock: "right" });
  }
  const existing = layout.widgets.find((widget) => widget.name === params.name);
  if (
    existing &&
    (existing.contentOwner !== params.content.kind ||
      ((params.content.kind === "plugin" || params.content.kind === "registered") &&
        (existing.pluginKind !== params.content.pluginKind ||
          (params.content.kind === "registered" &&
            existing.registeredContentKind !== params.content.contentKind))))
  ) {
    const incomingOwner =
      params.content.kind === "plugin" || params.content.kind === "registered"
        ? params.content.pluginKind
        : params.content.kind;
    throw new BoardValidationError(
      "invalid_operation",
      `board widget ${params.name} contains ${existing.pluginKind ?? existing.contentOwner} content; update it with the same content kind or remove it before replacing it with ${incomingOwner} content`,
    );
  }
  if (!existing && layout.widgets.length >= BOARD_MAX_WIDGETS) {
    throw new BoardValidationError(
      "invalid_operation",
      `board cannot contain more than ${BOARD_MAX_WIDGETS} widgets`,
    );
  }
  const tabId = params.placement?.tabId ?? existing?.tabId ?? layout.tabs[0]!.tabId;
  if (!layout.tabs.some((tab) => tab.tabId === tabId)) {
    throw new BoardValidationError("not_found", `board tab not found: ${tabId}`);
  }
  const size = BOARD_SIZE_PRESETS[(params.placement?.size ?? "md") as BoardSize];
  const widgetRevision = (existing?.revision ?? 0) + 1;
  const declared =
    params.content.kind === "plugin" ? undefined : normalizeBoardWidgetDeclared(params.declared);
  const declaredSummary = createBoardDeclaredSummary(declared);
  const contentSha256 =
    params.content.kind === "html"
      ? createHash("sha256").update(params.content.html).digest("hex")
      : params.content.kind === "registered"
        ? createHash("sha256").update(params.content.source).digest("hex")
        : undefined;
  // HTML grants are frozen to approved bytes. MCP App grants stay within the
  // source server. Either kind may narrow, but never widen, its declaration.
  const preservesGrant =
    declared !== undefined &&
    context.grantScopeMatches &&
    (params.content.kind !== "mcp-app" || params.content.interactive) &&
    existing?.grantState === "granted" &&
    (params.content.kind === "html" || params.content.kind === "registered"
      ? contentSha256 === context.grantedSha256
      : true) &&
    boardDeclarationIsSubset(declared, existing.declared);
  layout = insertBoardWidget(
    layout,
    {
      name: params.name,
      tabId,
      ...(params.title !== undefined
        ? { title: params.title }
        : existing?.title !== undefined
          ? { title: existing.title }
          : {}),
      contentKind: params.content.kind === "registered" ? "plugin" : params.content.kind,
      contentOwner: params.content.kind,
      ...(params.content.kind === "registered"
        ? { registeredContentKind: params.content.contentKind }
        : {}),
      ...(params.presentation !== undefined
        ? { presentation: params.presentation }
        : existing?.presentation !== undefined
          ? { presentation: existing.presentation }
          : {}),
      ...(params.heightMode !== undefined
        ? { heightMode: params.heightMode }
        : existing?.heightMode !== undefined
          ? { heightMode: existing.heightMode }
          : {}),
      ...(params.content.kind === "plugin" || params.content.kind === "registered"
        ? {
            pluginKind: params.content.pluginKind,
            ...(params.content.kind === "plugin" && params.content.props !== undefined
              ? { props: structuredClone(params.content.props) }
              : {}),
          }
        : {}),
      sizeW: params.placement?.size ? size.sizeW : (existing?.sizeW ?? size.sizeW),
      sizeH: params.placement?.size ? size.sizeH : (existing?.sizeH ?? size.sizeH),
      position: existing?.position ?? layout.widgets.length,
      grantState:
        params.content.kind === "plugin"
          ? "none"
          : preservesGrant
            ? "granted"
            : params.content.kind === "mcp-app" && !params.content.interactive
              ? "none"
              : declaredSummary || params.content.kind === "mcp-app"
                ? "pending"
                : "none",
      revision: widgetRevision,
      ...(params.content.kind !== "plugin" ? { instanceId: context.instanceId } : {}),
      ...(declaredSummary ? { declaredSummary } : {}),
      ...(declared ? { declared } : {}),
    },
    {
      tabId,
      ...(params.placement?.after ? { after: params.placement.after } : {}),
      move: params.placement?.tabId !== undefined || params.placement?.after !== undefined,
    },
  );
  if (!declaredSummary) {
    const widget = layout.widgets.find((candidate) => candidate.name === params.name)!;
    delete widget.declaredSummary;
    delete widget.declared;
  }
  return {
    sessionKey: params.sessionKey,
    revision: prior.revision + 1,
    ...layout,
  };
}

export function createBoardGrantSnapshot(
  current: BoardSnapshot,
  name: string,
  decision: "granted" | "rejected",
  revision: number,
  instanceId?: string,
): BoardSnapshot {
  const widget = current.widgets.find((candidate) => candidate.name === name);
  if (!widget) {
    throw new BoardValidationError("not_found", `board widget not found: ${name}`);
  }
  if (widget.revision !== revision) {
    throw new BoardValidationError(
      "conflict",
      `board widget revision changed: ${name} is revision ${widget.revision}, not ${revision}`,
    );
  }
  if (widget.instanceId !== undefined && widget.instanceId !== instanceId) {
    throw new BoardValidationError("conflict", `board widget instance changed: ${name}`);
  }
  if (widget.grantState !== "pending") {
    throw new BoardValidationError(
      "invalid_operation",
      `board widget grant is not pending: ${name}`,
    );
  }
  const snapshot = cloneBoardSnapshot(current);
  snapshot.widgets.find((candidate) => candidate.name === name)!.grantState = decision;
  snapshot.revision += 1;
  return snapshot;
}
