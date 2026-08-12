import { isLoopbackHost } from "./net.js";

/** Derive a Gateway-owned HTTP origin only from an attested direct-loopback connection. */
export function resolveLoopbackGatewayHttpOrigin(params: {
  requestHost?: string;
  directLocal: boolean;
  encrypted: boolean;
}): string | undefined {
  const host = params.requestHost?.trim();
  if (!params.directLocal || !host) {
    return undefined;
  }
  try {
    const parsed = new URL(`${params.encrypted ? "https" : "http"}://${host}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      !isLoopbackHost(parsed.hostname)
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}
