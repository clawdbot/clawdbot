import type { NextFunction, Request, Response } from "express";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isLoopbackHost } from "../gateway/net.js";

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function isMutatingMethod(method: string): boolean {
  const m = (method || "").trim().toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

function isLoopbackUrl(value: string): boolean {
  const v = value.trim();
  if (!v || v === "null") {
    return false;
  }
  try {
    const parsed = new URL(v);
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function shouldRejectBrowserMutation(params: {
  method: string;
  origin?: string;
  referer?: string;
  secFetchSite?: string;
}): boolean {
  if (!isMutatingMethod(params.method)) {
    return false;
  }

  // Strong signal when present: browser says this is cross-site.
  // Avoid being overly clever with "same-site" since localhost vs 127.0.0.1 may differ.
  const secFetchSite = normalizeLowercaseStringOrEmpty(params.secFetchSite);
  if (secFetchSite === "cross-site") {
    return true;
  }

  const origin = (params.origin ?? "").trim();
  if (origin) {
    return !isLoopbackUrl(origin);
  }

  const referer = (params.referer ?? "").trim();
  if (referer) {
    return !isLoopbackUrl(referer);
  }

  // Non-browser clients (curl/undici/Node) typically send no Origin/Referer.
  return false;
}

export function browserMutationGuardMiddleware(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    // OPTIONS is used for CORS preflight. Even if cross-origin, the preflight isn't mutating.
    const method = (req.method || "").trim().toUpperCase();
    if (method === "OPTIONS") {
      return next();
    }

    const origin = firstHeader(req.headers.origin);
    const referer = firstHeader(req.headers.referer);
    const secFetchSite = firstHeader(req.headers["sec-fetch-site"]);

    if (
      shouldRejectBrowserMutation({
        method,
        origin,
        referer,
        secFetchSite,
      })
    ) {
      res.status(403).send("Forbidden");
      return;
    }

    next();
  };
}
