export type MarkdownSidebarContent = {
  kind: "markdown";
  content: string;
  rawText?: string | null;
};

export type CanvasSidebarContent = {
  kind: "canvas";
  docId: string;
  title?: string;
  entryUrl: string;
  preferredHeight?: number;
  rawText?: string | null;
};

export type SidebarContent = MarkdownSidebarContent | CanvasSidebarContent;
