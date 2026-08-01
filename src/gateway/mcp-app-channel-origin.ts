type McpAppChannelOrigin = {
  origin: string;
  reachability: "tailnet" | "internet";
};

let publishedOrigin: (McpAppChannelOrigin & { owner: symbol }) | undefined;

/** Install the process-lifecycle snapshot used by terminal channel replies. */
export function prepareMcpAppChannelOrigin(snapshot: McpAppChannelOrigin): () => void {
  const url = new URL(snapshot.origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("MCP App channel origin must be an absolute HTTPS origin");
  }
  const owner = Symbol("mcp-app-channel-origin");
  publishedOrigin = { origin: url.origin, reachability: snapshot.reachability, owner };
  return () => {
    if (publishedOrigin?.owner === owner) {
      publishedOrigin = undefined;
    }
  };
}

export function getMcpAppChannelOrigin(): McpAppChannelOrigin | undefined {
  return publishedOrigin
    ? { origin: publishedOrigin.origin, reachability: publishedOrigin.reachability }
    : undefined;
}
