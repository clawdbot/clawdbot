import { createHash, randomBytes } from "node:crypto";
import type {
  BoardMcpAppDescriptor,
  BoardOp,
  BoardSnapshot,
  BoardWidgetContent,
  BoardWidgetPutParams,
} from "../../packages/gateway-protocol/src/index.js";
import {
  applyBoardOps,
  BOARD_SIZE_PRESETS,
  BoardValidationError,
  insertBoardWidget,
  normalizeBoardLayout,
  type BoardSize,
} from "./board-layout.js";

type BoardWidgetHtmlDocument = {
  html: string;
  revision: number;
  sha256: string;
  viewGeneration: string;
  grantState: "none" | "pending" | "granted" | "rejected";
};
type BoardWidgetMcpAppDocument = {
  descriptor: BoardMcpAppDescriptor;
  revision: number;
};
export type BoardWidgetDocument = BoardWidgetHtmlDocument | BoardWidgetMcpAppDocument;

export interface BoardStore {
  getSnapshot(sessionKey: string): BoardSnapshot;
  applyOps(sessionKey: string, ops: readonly BoardOp[]): BoardSnapshot;
  putWidget(params: BoardWidgetPutParams): BoardSnapshot;
  grant(
    sessionKey: string,
    name: string,
    decision: "granted" | "rejected",
    revision: number,
  ): BoardSnapshot;
  readWidgetHtml(sessionKey: string, name: string): BoardWidgetDocument | undefined;
  listSessionsWithBoards(): string[];
}

type StoredBoard = {
  snapshot: BoardSnapshot;
  documents: Map<string, BoardWidgetDocument>;
};

const BOARD_MAX_WIDGETS = 48;
const BOARD_MAX_WIDGET_HTML_BYTES = 256 * 1024;

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
      ...(widget.declaredSummary !== undefined
        ? { declaredSummary: [...widget.declaredSummary] }
        : {}),
    })),
  };
}

function createBoardWidgetDocument(
  content: BoardWidgetContent,
  revision: number,
  grantState: BoardWidgetHtmlDocument["grantState"],
): BoardWidgetDocument {
  if (content.kind === "html") {
    return {
      html: content.html,
      revision,
      sha256: createHash("sha256").update(content.html).digest("hex"),
      viewGeneration: randomBytes(16).toString("hex"),
      grantState,
    };
  }
  return { descriptor: { ...content.descriptor }, revision };
}

export function createBoardDeclaredSummary(
  declared: BoardWidgetPutParams["declared"],
): string[] | undefined {
  const lines = [
    ...(declared?.netOrigins ?? []).map((origin) => `Network access: ${origin}`),
    ...(declared?.tools ?? []).map((tool) => `Tool access: ${tool}`),
  ];
  return lines.length > 0 ? lines : undefined;
}

export function createBoardWidgetPutSnapshot(
  prior: BoardSnapshot,
  params: BoardWidgetPutParams,
): BoardSnapshot {
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
  const declaredSummary = createBoardDeclaredSummary(params.declared);
  // A grant follows new bytes only when every declared capability was already approved.
  // Any widening must return to pending before the widget can be served.
  const preservesGrant =
    existing?.grantState === "granted" &&
    (declaredSummary ?? []).every((entry) => existing.declaredSummary?.includes(entry));
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
      sizeW: params.placement?.size ? size.sizeW : (existing?.sizeW ?? size.sizeW),
      sizeH: params.placement?.size ? size.sizeH : (existing?.sizeH ?? size.sizeH),
      position: existing?.position ?? layout.widgets.length,
      grantState: preservesGrant ? "granted" : declaredSummary ? "pending" : "none",
      revision: widgetRevision,
      ...(declaredSummary ? { declaredSummary } : {}),
    },
    {
      tabId,
      ...(params.placement?.after ? { after: params.placement.after } : {}),
      move: params.placement?.tabId !== undefined || params.placement?.after !== undefined,
    },
  );
  if (!declaredSummary) {
    delete layout.widgets.find((widget) => widget.name === params.name)!.declaredSummary;
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

  putWidget(params: BoardWidgetPutParams): BoardSnapshot {
    const current = this.boards.get(params.sessionKey);
    const prior = current?.snapshot ?? emptyBoardSnapshot(params.sessionKey);
    const snapshot = createBoardWidgetPutSnapshot(prior, params);
    const documents = new Map(current?.documents ?? []);
    const widgetRevision = snapshot.widgets.find((widget) => widget.name === params.name)!.revision;
    const widget = snapshot.widgets.find((candidate) => candidate.name === params.name)!;
    documents.set(
      params.name,
      createBoardWidgetDocument(params.content, widgetRevision, widget.grantState),
    );
    this.boards.set(params.sessionKey, { snapshot, documents });
    return cloneBoardSnapshot(snapshot);
  }

  grant(
    sessionKey: string,
    name: string,
    decision: "granted" | "rejected",
    revision: number,
  ): BoardSnapshot {
    const current = this.boards.get(sessionKey);
    if (!current) {
      throw new BoardValidationError("not_found", `board widget not found: ${name}`);
    }
    const snapshot = createBoardGrantSnapshot(current.snapshot, name, decision, revision);
    const document = current.documents.get(name);
    if (document && "html" in document) {
      document.grantState = decision;
    }
    this.boards.set(sessionKey, { snapshot, documents: current.documents });
    return cloneBoardSnapshot(snapshot);
  }

  readWidgetHtml(sessionKey: string, name: string): BoardWidgetDocument | undefined {
    const document = this.boards.get(sessionKey)?.documents.get(name);
    if (!document) {
      return undefined;
    }
    return "html" in document
      ? { ...document }
      : { descriptor: { ...document.descriptor }, revision: document.revision };
  }

  listSessionsWithBoards(): string[] {
    return [...this.boards]
      .filter(([, board]) => board.snapshot.tabs.length > 0 || board.snapshot.widgets.length > 0)
      .map(([sessionKey]) => sessionKey)
      .toSorted();
  }
}
