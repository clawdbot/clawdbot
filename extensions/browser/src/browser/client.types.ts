export type BrowserTransport = "cdp" | "chrome-mcp";

export type BrowserTab = {
  targetId: string;
  title: string;
  url: string;
  wsUrl?: string;
  type?: string;
};

export type SnapshotAriaNode = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  backendDOMNodeId?: number;
  depth: number;
};
