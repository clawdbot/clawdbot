/**
 * Browser route utility functions.
 *
 * Profile lookup, JSON errors, and route value coercion shared across browser
 * control endpoints.
 */
import { BrowserProfileUnavailableError, type BrowserErrorResponse } from "../errors.js";
import {
  type BrowserRouteContext,
  type ProfileContext,
  withProfileContextOperation,
} from "../server-context.js";
import { isProfileRestartRequiredError } from "../server-context.lifecycle.js";
import type { BrowserRequest, BrowserResponse } from "./types.js";

function normalizeOptionalString(value: string): string | undefined {
  return value.trim() || undefined;
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
    const mapped = ctx.mapTabError(err);
    return mapped
      ? { error: mapped.message, status: mapped.status }
      : { error: String(err), status: 404 };
  }
}

/** Run one profile-scoped route transaction, restarting an unhealthy owned browser once. */
export async function runProfileRouteOperation<T>(params: {
  profileCtx: ProfileContext;
  signal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await withProfileContextOperation(params.profileCtx, params.signal, params.run);
    } catch (err) {
      if (!isProfileRestartRequiredError(err)) {
        throw err;
      }
      if (attempt !== 0) {
        throw new BrowserProfileUnavailableError(
          `Browser profile "${params.profileCtx.profile.name}" could not stabilize after restart.`,
        );
      }
      try {
        await params.profileCtx.ensureBrowserAvailable({ signal: params.signal });
      } catch (restartErr) {
        if (isProfileRestartRequiredError(restartErr)) {
          throw new BrowserProfileUnavailableError(
            `Browser profile "${params.profileCtx.profile.name}" could not restart.`,
          );
        }
        throw restartErr;
      }
    }
  }
  throw new Error("browser profile could not stabilize");
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

/** Return a canonical HTTP origin, or null when the route value is absent or invalid. */
export function readHttpOrigin(value: unknown): string | null {
  const raw = toStringOrEmpty(value);
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
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
