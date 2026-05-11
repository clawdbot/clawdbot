export function formatModelTransportDebugUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "<invalid-url>";
  }
}

export function formatModelTransportDebugBaseUrl(rawUrl: string | undefined): string {
  return rawUrl ? formatModelTransportDebugUrl(rawUrl) : "default";
}
