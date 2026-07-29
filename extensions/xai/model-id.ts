// Xai plugin module implements model id behavior.
export function normalizeXaiModelId(id: string): string {
  if (id === "grok-4.3-latest") {
    return "grok-4.3";
  }
  if (id === "grok-4.5-latest") {
    return "grok-4.5";
  }
  if (id === "grok-build-latest") {
    return "grok-4.5";
  }
  if (id === "grok-code-fast-1" || id === "grok-code-fast" || id === "grok-code-fast-1-0825") {
    return "grok-build-0.1";
  }
  if (id === "grok-4-fast-reasoning") {
    return "grok-4-fast";
  }
  if (id === "grok-4-1-fast-reasoning") {
    return "grok-4-1-fast";
  }
  return id;
}
