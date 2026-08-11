import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { executeBrowserScript, type BrowserExecHelperMethod } from "../browser-exec-engine.js";
import type { BrowserRouteContext } from "../server-context.js";
import { registerBrowserAgentActRoutes } from "./agent.act.js";
import { isActKind } from "./agent.act.shared.js";
import { registerBrowserAgentSnapshotRoutes } from "./agent.snapshot.js";
import { createBrowserRouteDispatcherCore } from "./dispatcher-core.js";
import { readRoutePositiveInteger } from "./route-numeric.js";
import { registerBrowserTabRoutes } from "./tabs.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError } from "./utils.js";

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return { ...value };
}

function readRouteError(body: unknown, status: number): Error {
  const message =
    body && typeof body === "object" && "error" in body
      ? String(body.error)
      : `Browser helper failed (${status})`;
  return new Error(message);
}

function registerExecHelperRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  registerBrowserTabRoutes(app, ctx);
  registerBrowserAgentSnapshotRoutes(app, ctx);
  registerBrowserAgentActRoutes(app, ctx);
}

function snapshotQuery(options: Record<string, unknown>, targetId?: string) {
  const query = { ...options };
  const snapshotFormat = query.snapshotFormat;
  delete query.snapshotFormat;
  delete query.profile;
  return {
    ...query,
    ...(snapshotFormat === "ai" || snapshotFormat === "aria" ? { format: snapshotFormat } : {}),
    ...(targetId && !normalizeOptionalString(query.targetId) ? { targetId } : {}),
  };
}

/** Register the agent-side Browser script execution endpoint. */
export function registerBrowserAgentExecRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post("/exec", async (req, res) => {
    if (!ctx.state().resolved.evaluateEnabled) {
      return jsonError(res, 404, "Not Found");
    }
    let body: Record<string, unknown>;
    try {
      body = readObject(req.body, "browser_exec body");
    } catch (error) {
      return jsonError(res, 400, error instanceof Error ? error.message : String(error));
    }
    const code = normalizeOptionalString(body.code);
    if (!code) {
      return jsonError(res, 400, "code is required");
    }
    let timeoutMs: number | undefined;
    try {
      timeoutMs = readRoutePositiveInteger(body.timeoutMs, "timeoutMs");
    } catch (error) {
      return jsonError(res, 400, error instanceof Error ? error.message : String(error));
    }
    const profile =
      normalizeOptionalString(body.profile) ?? normalizeOptionalString(req.query.profile);
    const pinnedTargetId = normalizeOptionalString(body.pinnedTargetId);
    let currentTargetId = normalizeOptionalString(body.targetId);
    const dispatcher = createBrowserRouteDispatcherCore({
      ctx,
      register: registerExecHelperRoutes,
    });

    const runHelper = async (params: {
      method: BrowserExecHelperMethod;
      params: unknown[];
      signal: AbortSignal;
    }) => {
      const [first] = params.params;
      let method: "GET" | "POST";
      let path: string;
      let query: Record<string, unknown> = profile ? { profile } : {};
      let helperBody: unknown;

      switch (params.method) {
        case "act": {
          const action = readObject(first, "act action");
          if (!isActKind(action.kind) || action.kind === "batch") {
            throw new Error("act(action) requires one supported non-batch action kind");
          }
          const requestedTargetId = normalizeOptionalString(action.targetId);
          if (pinnedTargetId && requestedTargetId && requestedTargetId !== pinnedTargetId) {
            throw new Error("browser_exec cannot override its run-bound tab target");
          }
          method = "POST";
          path = "/act";
          helperBody = {
            ...action,
            ...(!requestedTargetId && currentTargetId ? { targetId: currentTargetId } : {}),
          };
          break;
        }
        case "snapshot": {
          const options = first === undefined ? {} : readObject(first, "snapshot options");
          const requestedTargetId = normalizeOptionalString(options.targetId);
          if (pinnedTargetId && requestedTargetId && requestedTargetId !== pinnedTargetId) {
            throw new Error("browser_exec cannot override its run-bound tab target");
          }
          method = "GET";
          path = "/snapshot";
          query = { ...query, ...snapshotQuery(options, currentTargetId) };
          break;
        }
        case "open": {
          if (typeof first !== "string" || !first.trim()) {
            throw new Error("open(url) requires a URL string");
          }
          method = "POST";
          path = "/navigate";
          helperBody = { url: first, ...(currentTargetId ? { targetId: currentTargetId } : {}) };
          break;
        }
        case "tabs":
          method = "GET";
          path = "/tabs";
          break;
      }

      const response = await dispatcher.dispatch({
        method,
        path,
        query,
        body: helperBody,
        signal: params.signal,
      });
      if (response.status >= 400) {
        throw readRouteError(response.body, response.status);
      }
      if (response.body && typeof response.body === "object") {
        const responseBody = response.body as Record<string, unknown>;
        const responseTargetId = normalizeOptionalString(responseBody.targetId);
        if (responseTargetId) {
          currentTargetId = responseTargetId;
        }
        if (params.method === "tabs" && pinnedTargetId && Array.isArray(responseBody.tabs)) {
          return {
            ...responseBody,
            tabs: responseBody.tabs.filter(
              (tab) =>
                tab &&
                typeof tab === "object" &&
                normalizeOptionalString(tab.targetId) === pinnedTargetId,
            ),
          };
        }
      }
      return response.body;
    };

    const result = await executeBrowserScript({
      code,
      timeoutMs,
      signal: req.signal,
      host: runHelper,
    });
    res.json(result);
  });
}
