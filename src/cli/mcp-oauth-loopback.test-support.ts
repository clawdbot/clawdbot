export function createMcpOAuthBrowserFixture(port: number) {
  const redirectUrl = `http://127.0.0.1:${port}/oauth/callback`;
  const authorizationUrl = new URL("https://auth.example.com/authorize");
  authorizationUrl.searchParams.set("state", "state-1");
  authorizationUrl.searchParams.set("redirect_uri", redirectUrl);
  return {
    authorizationUrl,
    redirectUrl,
    serverConfig: {
      url: "https://mcp.example.com",
      transport: "streamable-http",
      auth: "oauth",
      oauth: { redirectUrl },
    },
  };
}
