const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

export function createGraphPageGuard(
  loadPage: (params: { token: string; path: string }) => Promise<unknown>,
) {
  return async (params: { url: string; init?: RequestInit }) => {
    const authorization = new Headers(params.init?.headers).get("authorization") ?? "";
    const payload = await loadPage({
      token: authorization.replace(/^Bearer /, ""),
      path: params.url.replace(GRAPH_ROOT, ""),
    });
    return {
      response: new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
      }),
      finalUrl: params.url,
      release: async () => undefined,
    };
  };
}
