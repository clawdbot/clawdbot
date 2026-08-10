import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Lightweight HTTP helpers (no internal imports needed)
// ---------------------------------------------------------------------------

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function sendMethodNotAllowed(res: ServerResponse) {
  res.setHeader("Allow", "POST");
  res.statusCode = 405;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Method Not Allowed");
}

export function sendUnauthorized(res: ServerResponse) {
  sendJson(res, 401, { error: { message: "Authentication required", type: "unauthorized" } });
}

export function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export function getBearerToken(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization?.trim() ?? "";
  if (!raw.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  return raw.slice(7).trim() || undefined;
}

// ---------------------------------------------------------------------------
// Session-key header validation
// ---------------------------------------------------------------------------

/**
 * Validate an `X-OpenClaw-Session-Key` header value.
 *
 * Returns the trimmed value if valid, or `null` if it must be rejected.
 * The header is intended to be set by a trusted reverse proxy that has
 * already authenticated the user — we still validate defensively so a
 * misconfigured proxy or a bypass cannot introduce path-traversal or
 * oversized keys into the session store.
 */
export function validateSessionKeyHeader(raw: string): string | null {
  const v = raw.trim();
  if (!v || v.length > 256) {
    return null;
  }
  // Reject path-traversal and separators explicitly; the allowlist below also
  // rejects any other unexpected byte (including NUL and control characters).
  if (v.includes("..") || v.includes("/") || v.includes("\\")) {
    return null;
  }
  if (!/^[A-Za-z0-9._@:-]+$/.test(v)) {
    return null;
  }
  return v;
}

// ---------------------------------------------------------------------------
// HMAC-signed device token utilities
// ---------------------------------------------------------------------------

export function createDeviceToken(secret: string, deviceId: string): string {
  const encodedId = Buffer.from(deviceId).toString("base64url");
  const signature = createHmac("sha256", secret).update(deviceId).digest("hex").slice(0, 32);
  return `${encodedId}.${signature}`;
}

export function verifyDeviceToken(token: string, secret: string): string | null {
  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0 || dotIndex >= token.length - 1) {
    return null;
  }

  const encodedId = token.slice(0, dotIndex);
  const providedSig = token.slice(dotIndex + 1);

  try {
    const deviceId = Buffer.from(encodedId, "base64url").toString("utf-8");

    // Validate it looks like a UUID
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) {
      return null;
    }

    const expectedSig = createHmac("sha256", secret).update(deviceId).digest("hex").slice(0, 32);

    // Constant-time comparison
    if (providedSig.length !== expectedSig.length) {
      return null;
    }
    const providedBuf = Buffer.from(providedSig);
    const expectedBuf = Buffer.from(expectedSig);
    if (!timingSafeEqual(providedBuf, expectedBuf)) {
      return null;
    }

    return deviceId;
  } catch {
    return null;
  }
}

/**
 * Composes the persisted session key from its parts.
 *
 * Each component is encoded before joining. Raw concatenation let distinct
 * pairs collide: a user key may itself contain `:`, and thread ids are
 * arbitrary client strings, so user `"a:thread:b"` and user `"a"` + thread
 * `"b"` produced the same key — and therefore shared one transcript.
 * Lowercasing the thread id additionally merged ids differing only by case.
 * `encodeURIComponent` escapes `:` and `%`, so parts stay unambiguous and case
 * is preserved.
 */
export function composeAguiSessionKey(
  routeSessionKey: string,
  userKey: string | undefined,
  threadId: string | undefined,
): string {
  let key = routeSessionKey;
  if (userKey) {
    key += `:user:${encodeURIComponent(userKey)}`;
  }
  if (threadId) {
    key += `:thread:${encodeURIComponent(threadId)}`;
  }
  return key;
}

/**
 * Whether a string survives URI component encoding.
 *
 * `encodeURIComponent` throws `URIError` on malformed UTF-16 (a lone surrogate
 * such as "\uD800"). Client-supplied thread ids are arbitrary strings, so the
 * composer must not be the thing that discovers that — the caller checks first
 * and answers 400.
 */
export function isEncodableSessionComponent(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}
