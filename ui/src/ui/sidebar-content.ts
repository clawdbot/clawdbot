// Control UI module implements sidebar content behavior.
export type SidebarFullMessageRequest = {
  sessionKey: string;
  agentId?: string;
  messageId: string;
  kind: "assistant_message" | "tool_output";
};

export type MarkdownSidebarContent = {
  kind: "markdown";
  content: string;
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: "not_found" | "oversized" | "not_visible" | null;
};

export type CanvasSidebarContent = {
  kind: "canvas";
  docId: string;
  title?: string;
  entryUrl: string;
  preferredHeight?: number;
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: "not_found" | "oversized" | "not_visible" | null;
};

export type SidebarContent = MarkdownSidebarContent | CanvasSidebarContent;
