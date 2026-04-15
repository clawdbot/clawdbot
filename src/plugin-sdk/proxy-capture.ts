type ProxyCaptureSettings = {
  enabled: boolean;
  url?: string;
};

export function resolveDebugProxySettings(): ProxyCaptureSettings {
  const url =
    process.env.OPENCLAW_DEBUG_PROXY_URL ||
    process.env.DEBUG_PROXY_URL ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    "";
  return { enabled: Boolean(url), ...(url ? { url } : {}) };
}

export function resolveEffectiveDebugProxyUrl(settings?: ProxyCaptureSettings): string | undefined {
  return settings?.url;
}

export function createDebugProxyWebSocketAgent(_settings?: ProxyCaptureSettings): undefined {
  return undefined;
}

export function isDebugProxyGlobalFetchPatchInstalled(): boolean {
  return false;
}

export async function captureHttpExchange<T>(params: {
  request: () => Promise<T>;
}): Promise<T> {
  return await params.request();
}

export function captureWsEvent<T>(event: T): T {
  return event;
}

export function getDebugProxyCaptureStore(_dbPath?: string, _blobDir?: string) {
  return {
    queryPreset: async () => [],
    close: async () => {},
  };
}
