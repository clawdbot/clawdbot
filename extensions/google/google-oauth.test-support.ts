type VertexAdcTestApi = {
  reset: () => void;
};

function requireTestApi(key: string): unknown {
  const api = (globalThis as Record<PropertyKey, unknown>)[Symbol.for(key)];
  if (!api) {
    throw new Error(`Google test API is unavailable: ${key}`);
  }
  return api;
}

export function resetGoogleVertexAdcState(): void {
  (requireTestApi("openclaw.google.vertexAdcTestApi") as VertexAdcTestApi).reset();
}
