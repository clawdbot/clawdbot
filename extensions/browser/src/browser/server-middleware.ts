import type { Express, Request } from "express";
import express from "express";
import { browserMutationGuardMiddleware } from "./csrf.js";
import { isAuthorizedBrowserRequest } from "./http-auth.js";

const BROWSER_AUTH_VERIFIED_FLAG = "__openclawBrowserAuthVerified";

type BrowserAuthMarkedRequest = Request & {
  [BROWSER_AUTH_VERIFIED_FLAG]?: boolean;
};

export function hasVerifiedBrowserAuth(req: Request): boolean {
  return (req as BrowserAuthMarkedRequest)[BROWSER_AUTH_VERIFIED_FLAG] === true;
}

function markVerifiedBrowserAuth(req: Request) {
  (req as BrowserAuthMarkedRequest)[BROWSER_AUTH_VERIFIED_FLAG] = true;
}

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
    // Make the signal available to browser route handlers (best-effort).
    (req as unknown as { signal?: AbortSignal }).signal = ctrl.signal;
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(browserMutationGuardMiddleware());
}

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
