/**
 * Shared Express middleware for Browser control routes, including auth marking,
 * JSON parsing, abort signals, and mutation CSRF checks.
 */
import type { Express, Request } from "express";
import express from "express";
import { browserMutationGuardMiddleware } from "./csrf.js";
import { isAuthorizedBrowserRequest } from "./http-auth.js";

const BROWSER_AUTH_VERIFIED_FLAG = "__openclawBrowserAuthVerified";

type BrowserAuthMarkedRequest = Request & {
  [BROWSER_AUTH_VERIFIED_FLAG]?: boolean;
};

/** Returns whether Browser auth middleware already verified this request. */
export function hasVerifiedBrowserAuth(req: Request): boolean {
  return (req as BrowserAuthMarkedRequest)[BROWSER_AUTH_VERIFIED_FLAG] === true;
}

function markVerifiedBrowserAuth(req: Request) {
  (req as BrowserAuthMarkedRequest)[BROWSER_AUTH_VERIFIED_FLAG] = true;
}

/** Installs common Browser control-server middleware. */
export function installBrowserCommonMiddleware(app: Express) {
  app.use((req, res, next) => {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort(new Error("request aborted"));
    req.once("aborted", abort);
    res.once("close", () => {
      if (!res.writableEnded) {
        abort();
      }
    });
    // Node 24.16+'s native request signal aborts when a POST body finishes.
    // Browser work follows the client/response lifetime instead.
    Object.defineProperty(req, "signal", {
      value: ctrl.signal,
      configurable: true,
    });
    next();
  });
  app.use(browserMutationGuardMiddleware());
  app.use(express.json({ limit: "1mb" }));
}

/** Installs optional token/password auth for Browser control-server requests. */
export function installBrowserAuthMiddleware(
  app: Express,
  auth: { token?: string; password?: string },
) {
  if (!auth.token && !auth.password) {
    return;
  }
  app.use((req, res, next) => {
    if (isAuthorizedBrowserRequest(req, auth)) {
      markVerifiedBrowserAuth(req);
      return next();
    }
    res.status(401).send("Unauthorized");
  });
}
