// This QA-only preload substitutes named external upstreams with a local HTTP fixture.
// Gateway routing, config publication, credentials, and response parsing remain real.
const fixture = new URL(import.meta.url).searchParams.get("fixture");
if (!fixture || new URL(fixture).hostname !== "127.0.0.1") {
  throw new Error("Hot reload upstream fixture must use loopback");
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const fixturePath =
    url.origin === "https://api.github.com"
      ? `/github${url.pathname}${url.search}`
      : url.origin === "https://example.com" && url.pathname === "/favicon.ico"
        ? "/favicon.ico"
        : null;
  if (!fixturePath) {
    return originalFetch(input, init);
  }
  const fixtureInit = { ...init };
  delete fixtureInit.dispatcher;
  return originalFetch(`${fixture}${fixturePath}`, fixtureInit);
};
// Use the existing hermetic fetch contract so guarded favicon requests reach
// this fixture instead of selecting Undici's DNS-pinned external transport.
globalThis.fetch.mock = {};
