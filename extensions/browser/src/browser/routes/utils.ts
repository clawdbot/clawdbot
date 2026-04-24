import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteHandler } from "./types.js";

function normalizeOptionalString(value: string): string | undefined {
  return value.trim() || undefined;
}

export function asyncBrowserRoute(handler: BrowserRouteHandler): BrowserRouteHandler {
  return (req, res) => handler(req, res);
}

/**
 * Extract profile name from query string or body and get profile context.
 * Query string takes precedence over body for consistency with GET routes.
 */
export function getProfileContext(
  req: BrowserRequest,
  ctx: BrowserRouteContext,
): ProfileContext | { error: string; status: number } {
  let profileName: string | undefined;

  // Check query string first (works for GET and POST)
  if (typeof req.query.profile === "string") {
    profileName = normalizeOptionalString(req.query.profile);
  }

  // Fall back to body for POST requests
  if (!profileName && req.body && typeof req.body === "object") {
    const body = req.body as Record<string, unknown>;
    if (typeof body.profile === "string") {
      profileName = normalizeOptionalString(body.profile);
    }
  }

  try {
    return ctx.forProfile(profileName);
  } catch (err) {
    return { error: String(err), status: 404 };
  }
}

export function jsonError(res: BrowserResponse, status: number, message: string) {
  res.status(status).json({ error: message });
}

export function toStringOrEmpty(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return normalizeOptionalString(String(value)) ?? "";
  }
  return "";
}

export function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const normalized = typeof value === "string" ? normalizeOptionalString(value) : undefined;
  if (normalized) {
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function toBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return undefined;
}

export function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.map((v) => toStringOrEmpty(v)).filter(Boolean);
  return strings.length ? strings : undefined;
}
