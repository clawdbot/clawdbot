/**
 * Browser route utility functions.
 *
 * Wraps async handlers, profile lookup, JSON errors, and route value coercion
 * shared across browser control endpoints.
 */
import type { BrowserErrorResponse } from "../errors.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteHandler } from "./types.js";

function normalizeOptionalString(value: string): string | undefined {
  return value.trim() || undefined;
}

/** Convert thrown async route errors into next(error) calls for the HTTP layer. */
export function asyncBrowserRoute(handler: BrowserRouteHandler): BrowserRouteHandler {
  return (req, res) => handler(req, res);
}

/**
 * Extract profile name from query string or body and get profile context.
 * Query string takes precedence over body for consistency with GET routes.
 */
/** Resolve the profile context requested by query/profile parameters. */
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

/** Send a simple JSON error response. */
export function jsonError(res: BrowserResponse, status: number, message: string) {
  res.status(status).json({ error: message });
}

/** Send a mapped browser-domain error while preserving validated metadata. */
export function jsonBrowserError(res: BrowserResponse, error: BrowserErrorResponse) {
  const body =
    "reason" in error
      ? { error: error.message, reason: error.reason, details: error.details }
      : { error: error.message };
  res.status(error.status).json(body);
}

/** Coerce route values to strings while treating nullish values as empty. */
export function toStringOrEmpty(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return normalizeOptionalString(String(value)) ?? "";
  }
  return "";
}

/** Coerce route numeric values from numbers or decimal strings. */
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

/** Coerce route boolean values from booleans or common string forms. */
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

/** Coerce a route value to a string array when every entry is a string. */
export function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.map((v) => toStringOrEmpty(v)).filter(Boolean);
  return strings.length ? strings : undefined;
}
