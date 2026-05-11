import type { IncomingMessage } from "node:http";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeEqualSecret } from "../security/secret-equal.js";

function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function parseBearerToken(authorization: string): string | undefined {
  if (!normalizeLowercaseStringOrEmpty(authorization).startsWith("bearer ")) {
    return undefined;
  }
  const token = authorization.slice(7).trim();
  return token || undefined;
}

function parseBasicPassword(authorization: string): string | undefined {
  if (!normalizeLowercaseStringOrEmpty(authorization).startsWith("basic ")) {
    return undefined;
  }
  const encoded = authorization.slice(6).trim();
  if (!encoded) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep < 0) {
      return undefined;
    }
    const password = decoded.slice(sep + 1).trim();
    return password || undefined;
  } catch {
    return undefined;
  }
}

export function isAuthorizedBrowserRequest(
  req: IncomingMessage,
  auth: { token?: string; password?: string },
): boolean {
  const authorization = firstHeaderValue(req.headers.authorization).trim();

  if (auth.token) {
    const bearer = parseBearerToken(authorization);
    if (bearer && safeEqualSecret(bearer, auth.token)) {
      return true;
    }
  }

  if (auth.password) {
    const passwordHeader = firstHeaderValue(req.headers["x-openclaw-password"]).trim();
    if (passwordHeader && safeEqualSecret(passwordHeader, auth.password)) {
      return true;
    }

    const basicPassword = parseBasicPassword(authorization);
    if (basicPassword && safeEqualSecret(basicPassword, auth.password)) {
      return true;
    }
  }

  return false;
}
