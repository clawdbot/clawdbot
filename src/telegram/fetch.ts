// Bun-only: force native fetch to avoid grammY's Node shim under Bun.
export function resolveTelegramFetch(
  proxyFetch?: typeof fetch,
): typeof fetch | undefined {
  if (proxyFetch) return proxyFetch;
  const fetchImpl = globalThis.fetch;
  const isBun = "Bun" in globalThis || Boolean(process?.versions?.bun);
  if (!isBun) return undefined;
  if (!fetchImpl) {
    throw new Error(
      "fetch is not available; set channels.telegram.proxy in config",
    );
  }
  return fetchImpl;
}
