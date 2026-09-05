/** Validate before attaching credentials, including when adapters are used directly. */
export function parseGuardBaseUrl(value: string): string {
  const invalid = () => new Error("Invalid Reef guard base URL");
  // oxlint-disable-next-line no-control-regex -- Reject URL normalization of control bytes before attaching credentials.
  if (/[\s\\?#\u0000-\u001f\u007f]/.test(value)) {
    throw invalid();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  const authority = /^https?:\/\/([^/]+)/i.exec(value)?.[1];
  const numericLoopback =
    authority !== undefined &&
    (/^127(?:\.(?:0|[1-9]\d{0,2})){3}(?::\d+)?$/.test(authority) ||
      /^\[::1\](?::\d+)?$/.test(authority));
  if (
    !authority ||
    url.username ||
    url.password ||
    authority.includes("@") ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && numericLoopback))
  ) {
    throw invalid();
  }
  return url.href.replace(/\/+$/, "");
}
