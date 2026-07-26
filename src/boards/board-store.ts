import { createHash, randomBytes } from "node:crypto";
import type {
  BoardMcpAppDescriptor,
  BoardOp,
  BoardSnapshot,
  BoardWidgetMaterializedContent,
  BoardWidgetMaterializedPutParams,
  BoardWidgetDeclared,
} from "../../packages/gateway-protocol/src/index.js";
import { boardDeclarationIsSubset, normalizeBoardWidgetDeclared } from "./board-capabilities.js";
import {
  applyBoardOps,
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
};
export type BoardWidgetMcpAppDocument = {
  descriptor: BoardMcpAppDescriptor;
  revision: number;
  instanceId: string;
  grantState: "none" | "pending" | "granted" | "rejected";
  declaredTools: string[];
  interactive: boolean;
};
export type BoardWidgetDocument = BoardWidgetHtmlDocument | BoardWidgetMcpAppDocument;

export interface BoardStore {
  getSnapshot(sessionKey: string): BoardSnapshot;
  applyOps(sessionKey: string, ops: readonly BoardOp[]): BoardSnapshot;
  putWidget(params: BoardWidgetMaterializedPutParams): BoardSnapshot;
  grant(
    sessionKey: string,
    name: string,
    decision: "granted" | "rejected",
    revision: number,
    instanceId?: string,
  ): BoardSnapshot;
  readWidgetHtml(sessionKey: string, name: string): BoardWidgetHtmlDocument | undefined;
  readWidgetMcpApp(sessionKey: string, name: string): BoardWidgetMcpAppDocument | undefined;
  listSessionsWithBoards(): string[];
}

type StoredBoard = {
  snapshot: BoardSnapshot;
  documents: Map<string, BoardWidgetDocument>;
};

const BOARD_MAX_WIDGETS = 48;
const BOARD_MAX_WIDGET_HTML_BYTES = 256 * 1024;
const BOARD_MAX_WIDGET_PLUGIN_PROPS_BYTES = 8 * 1024;

function emptyBoardSnapshot(sessionKey: string): BoardSnapshot {
  return { sessionKey, revision: 0, tabs: [], widgets: [] };
}

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

function createBoardWidgetDocument(
  content: BoardWidgetMaterializedContent,
  revision: number,
  grantState: BoardWidgetHtmlDocument["grantState"],
  declared: BoardWidgetDeclared | undefined,
  instanceId: string,
): BoardWidgetDocument | undefined {
  if (content.kind === "html") {
    return {
      html: content.html,
      revision,
      sha256: createHash("sha256").update(content.html).digest("hex"),
      viewGeneration: instanceId,
      grantState,
      ...(declared ? { declared } : {}),
    };
  }
  if (content.kind === "plugin") {
    return undefined;
  }
  return {
    descriptor: { ...content.descriptor },
    revision,
    instanceId,
    grantState,
    declaredTools: [...(declared?.tools ?? [])],
    interactive: content.interactive,
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

type BoardWidgetGrantScope =
  | { kind: "html" }
  | { kind: "mcp-app"; serverName: string }
  | { kind: "plugin" };

function grantScopeMatches(
  previous: BoardWidgetDocument | undefined,
  content: BoardWidgetMaterializedContent,
) {
  const prior: BoardWidgetGrantScope | undefined = previous
    ? "html" in previous
      ? { kind: "html" }
      : { kind: "mcp-app", serverName: previous.descriptor.serverName }
    : undefined;
  const next: BoardWidgetGrantScope =
    content.kind === "html"
      ? { kind: "html" }
      : content.kind === "mcp-app"
        ? { kind: "mcp-app", serverName: content.descriptor.serverName }
        : { kind: "plugin" };
  return (
    prior === undefined ||
    (prior.kind === "html" && next.kind === "html") ||
    (prior.kind === "mcp-app" && next.kind === "mcp-app" && prior.serverName === next.serverName)
  );
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
      : undefined;
  // HTML grants are frozen to approved bytes. MCP App grants stay within the
  // source server. Either kind may narrow, but never widen, its declaration.
  const preservesGrant =
    declared !== undefined &&
    context.grantScopeMatches &&
    (params.content.kind !== "mcp-app" || params.content.interactive) &&
    existing?.grantState === "granted" &&
    (params.content.kind === "html" ? contentSha256 === context.grantedSha256 : true) &&
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
      contentKind: params.content.kind,
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
      ...(params.content.kind === "plugin"
        ? {
            pluginKind: params.content.pluginKind,
            ...(params.content.props !== undefined
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

export class InMemoryBoardStore implements BoardStore {
  private readonly boards = new Map<string, StoredBoard>();

  getSnapshot(sessionKey: string): BoardSnapshot {
    return cloneBoardSnapshot(
      this.boards.get(sessionKey)?.snapshot ?? emptyBoardSnapshot(sessionKey),
    );
  }

  applyOps(sessionKey: string, ops: readonly BoardOp[]): BoardSnapshot {
    const current = this.boards.get(sessionKey);
    const snapshot = current?.snapshot ?? emptyBoardSnapshot(sessionKey);
    if (ops.length === 0) {
      return cloneBoardSnapshot(snapshot);
    }
    const layout = applyBoardOps(snapshot, ops);
    const next: BoardSnapshot = {
      sessionKey,
      revision: snapshot.revision + 1,
      ...layout,
    };
    const removedNames = new Set(next.widgets.map((widget) => widget.name));
    const documents = new Map(
      [...(current?.documents ?? [])].filter(([name]) => removedNames.has(name)),
    );
    if (next.tabs.length === 0 && next.widgets.length === 0) {
      this.boards.delete(sessionKey);
    } else {
      this.boards.set(sessionKey, { snapshot: next, documents });
    }
    return cloneBoardSnapshot(next);
  }

  putWidget(params: BoardWidgetMaterializedPutParams): BoardSnapshot {
    const declared = normalizeBoardWidgetDeclared(params.declared);
    const canonicalParams: BoardWidgetMaterializedPutParams = { ...params };
    if (declared) {
      canonicalParams.declared = declared;
    } else {
      delete canonicalParams.declared;
    }
    const current = this.boards.get(canonicalParams.sessionKey);
    const prior = current?.snapshot ?? emptyBoardSnapshot(canonicalParams.sessionKey);
    const existingDocument = current?.documents.get(canonicalParams.name);
    const grantedSha256 =
      existingDocument && "html" in existingDocument && existingDocument.grantState === "granted"
        ? existingDocument.sha256
        : undefined;
    const instanceId = randomBytes(16).toString("hex");
    const snapshot = createBoardWidgetPutSnapshot(prior, canonicalParams, {
      grantScopeMatches: grantScopeMatches(existingDocument, canonicalParams.content),
      grantedSha256,
      instanceId,
    });
    const documents = new Map(current?.documents ?? []);
    const widgetRevision = snapshot.widgets.find(
      (widget) => widget.name === canonicalParams.name,
    )!.revision;
    const widget = snapshot.widgets.find((candidate) => candidate.name === canonicalParams.name)!;
    const document = createBoardWidgetDocument(
      canonicalParams.content,
      widgetRevision,
      widget.grantState,
      declared,
      instanceId,
    );
    if (document) {
      documents.set(canonicalParams.name, document);
    } else {
      documents.delete(canonicalParams.name);
    }
    this.boards.set(canonicalParams.sessionKey, { snapshot, documents });
    return cloneBoardSnapshot(snapshot);
  }

  grant(
    sessionKey: string,
    name: string,
    decision: "granted" | "rejected",
    revision: number,
    instanceId?: string,
  ): BoardSnapshot {
    const current = this.boards.get(sessionKey);
    if (!current) {
      throw new BoardValidationError("not_found", `board widget not found: ${name}`);
    }
    const snapshot = createBoardGrantSnapshot(
      current.snapshot,
      name,
      decision,
      revision,
      instanceId,
    );
    const document = current.documents.get(name);
    if (document) {
      document.grantState = decision;
    }
    this.boards.set(sessionKey, { snapshot, documents: current.documents });
    return cloneBoardSnapshot(snapshot);
  }

  readWidgetHtml(sessionKey: string, name: string): BoardWidgetHtmlDocument | undefined {
    const document = this.boards.get(sessionKey)?.documents.get(name);
    if (!document) {
      return undefined;
    }
    return "html" in document
      ? {
          ...document,
          ...(document.declared
            ? {
                declared: {
                  ...(document.declared.netOrigins
                    ? { netOrigins: [...document.declared.netOrigins] }
                    : {}),
                  ...(document.declared.tools ? { tools: [...document.declared.tools] } : {}),
                },
              }
            : {}),
        }
      : undefined;
  }

  readWidgetMcpApp(sessionKey: string, name: string): BoardWidgetMcpAppDocument | undefined {
    const document = this.boards.get(sessionKey)?.documents.get(name);
    return document && !("html" in document)
      ? {
          ...document,
          descriptor: { ...document.descriptor },
          declaredTools: [...document.declaredTools],
        }
      : undefined;
  }

  listSessionsWithBoards(): string[] {
    return [...this.boards]
      .filter(([, board]) => board.snapshot.tabs.length > 0 || board.snapshot.widgets.length > 0)
      .map(([sessionKey]) => sessionKey)
      .toSorted();
  }
}
