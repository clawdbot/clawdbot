import type { SessionDiffFileTextLoader, SessionDiffLoader } from "./session-diff-panel.ts";
import "./chat-detail-panel.ts";

type DetailUnavailableReason = "not_found" | "oversized" | "not_visible";
type DetailFullMessageResult = {
  ok?: boolean;
  message?: unknown;
  unavailableReason?: DetailUnavailableReason;
};

type SidebarFullMessageRequest = {
  sessionKey: string;
  agentId?: string;
  messageId: string;
  kind: "assistant_message" | "tool_output";
};

export type SidebarFullMessageLoader = (
  request: SidebarFullMessageRequest,
) => Promise<DetailFullMessageResult | null | undefined>;

type MarkdownSidebarContent = {
  kind: "markdown";
  content: string;
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: DetailUnavailableReason | null;
};

type CanvasSidebarContent = {
  kind: "canvas";
  docId: string;
  title?: string;
  entryUrl: string;
  preferredHeight?: number;
  /** Per-preview sandbox ceiling; keeps widget iframes below the global embed mode. */
  sandbox?: "strict" | "scripts";
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: DetailUnavailableReason | null;
};

type ImageSidebarContent = {
  kind: "image";
  title: string;
  src: string;
  mimeType?: string | null;
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: DetailUnavailableReason | null;
};

type SessionDiffSidebarContent = {
  kind: "session-diff";
  /** Fetches a fresh sessions.diff snapshot; the panel refetches on refresh. */
  load: SessionDiffLoader;
  loadFileText?: SessionDiffFileTextLoader;
  openFile?: (path: string) => void;
  revealFile?: (path: string) => void;
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: DetailUnavailableReason | null;
};

type FileSaveOutcome =
  | { ok: true; hash: string; updatedAtMs?: number }
  | { ok: false; code: "conflict"; currentHash?: string }
  | { ok: false; code: "error"; message: string };

type FileSidebarEdit = {
  hash: string;
  save: (params: { content: string; expectedHash: string }) => Promise<FileSaveOutcome>;
  /** `editable: false` means the latest content no longer qualifies for edit mode. */
  fetchLatest: () => Promise<{ content: string; hash: string; editable: boolean } | null>;
};

type FileSidebarContent = {
  kind: "file";
  path: string;
  name: string;
  content: string;
  /** Stable per-session identity used to retain an unsaved in-memory draft. */
  draftKey?: string;
  root?: string | null;
  language?: string;
  line?: number | null;
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: DetailUnavailableReason | null;
  edit?: FileSidebarEdit;
};

export type SidebarContent =
  | MarkdownSidebarContent
  | CanvasSidebarContent
  | ImageSidebarContent
  | FileSidebarContent
  | SessionDiffSidebarContent
  | { kind: "task"; taskId: string };

export { hasUniformLineEndings } from "./chat-sidebar-file-view.ts";
