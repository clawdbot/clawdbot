import {
  assertHttpUrlTargetsPrivateNetwork,
  type LookupFn,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { isPrivateOrLoopbackHost } from "./private-network-host.js";

const MATRIX_HTTP_HOMESERVER_ERROR =
  "Matrix homeserver must use https:// unless it targets a private or loopback host";

function cleanString(value: unknown, requiredMessage: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    throw new Error(requiredMessage);
  }
  return trimmed;
}

export function validateMatrixHomeserverUrl(
  homeserver: string,
  opts?: { allowPrivateNetwork?: boolean },
): string {
  const trimmed = cleanString(homeserver, "Matrix homeserver is required (matrix.homeserver)");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Matrix homeserver must be a valid http(s) URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Matrix homeserver must use http:// or https://");
  }
  if (!parsed.hostname) {
    throw new Error("Matrix homeserver must include a hostname");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Matrix homeserver URL must not include embedded credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Matrix homeserver URL must not include query strings or fragments");
  }
  if (
    parsed.protocol === "http:" &&
    opts?.allowPrivateNetwork !== true &&
    !isPrivateOrLoopbackHost(parsed.hostname)
  ) {
    throw new Error(MATRIX_HTTP_HOMESERVER_ERROR);
  }

  return trimmed;
}

export async function resolveValidatedMatrixHomeserverUrl(
  homeserver: string,
  opts?: {
    dangerouslyAllowPrivateNetwork?: boolean;
    allowPrivateNetwork?: boolean;
    lookupFn?: LookupFn;
  },
): Promise<string> {
  const allowPrivateNetwork =
    typeof opts?.dangerouslyAllowPrivateNetwork === "boolean"
      ? opts.dangerouslyAllowPrivateNetwork
      : opts?.allowPrivateNetwork;
  const normalized = validateMatrixHomeserverUrl(homeserver, {
    allowPrivateNetwork,
  });
  await assertHttpUrlTargetsPrivateNetwork(normalized, {
    dangerouslyAllowPrivateNetwork: opts?.dangerouslyAllowPrivateNetwork,
    allowPrivateNetwork,
    lookupFn: opts?.lookupFn,
    errorMessage: MATRIX_HTTP_HOMESERVER_ERROR,
  });
  return normalized;
}
