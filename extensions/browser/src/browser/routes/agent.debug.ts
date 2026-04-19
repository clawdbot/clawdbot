import crypto from "node:crypto";
import path from "node:path";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { BrowserRouteContext } from "../server-context.js";
import {
  readBody,
  resolveTargetIdFromBody,
  resolveTargetIdFromQuery,
  withPlaywrightRouteContext,
} from "./agent.shared.js";
import { resolveWritableOutputPathOrRespond } from "./output-paths.js";
import { DEFAULT_TRACE_DIR } from "./path-output.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { asyncBrowserRoute, toBoolean, toStringOrEmpty } from "./utils.js";

export function registerBrowserAgentDebugRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.get(
    "/console",
    asyncBrowserRoute(async (req, res) => {
      const targetId = resolveTargetIdFromQuery(req.query);
      const level = typeof req.query.level === "string" ? req.query.level : "";

      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "console messages",
        run: async ({ cdpUrl, tab, pw }) => {
          const messages = await pw.getConsoleMessagesViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            level: normalizeOptionalString(level),
          });
          res.json({ ok: true, messages, targetId: tab.targetId });
        },
      });
    }),
  );

  app.get(
    "/errors",
    asyncBrowserRoute(async (req, res) => {
      const targetId = resolveTargetIdFromQuery(req.query);
      const clear = toBoolean(req.query.clear) ?? false;

      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "page errors",
        run: async ({ cdpUrl, tab, pw }) => {
          const result = await pw.getPageErrorsViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            clear,
          });
          res.json({ ok: true, targetId: tab.targetId, ...result });
        },
      });
    }),
  );

  app.get(
    "/requests",
    asyncBrowserRoute(async (req, res) => {
      const targetId = resolveTargetIdFromQuery(req.query);
      const filter = typeof req.query.filter === "string" ? req.query.filter : "";
      const clear = toBoolean(req.query.clear) ?? false;

      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "network requests",
        run: async ({ cdpUrl, tab, pw }) => {
          const result = await pw.getNetworkRequestsViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            filter: normalizeOptionalString(filter),
            clear,
          });
          res.json({ ok: true, targetId: tab.targetId, ...result });
        },
      });
    }),
  );

  app.post(
    "/trace/start",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      const screenshots = toBoolean(body.screenshots) ?? undefined;
      const snapshots = toBoolean(body.snapshots) ?? undefined;
      const sources = toBoolean(body.sources) ?? undefined;

      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "trace start",
        run: async ({ cdpUrl, tab, pw }) => {
          await pw.traceStartViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            screenshots,
            snapshots,
            sources,
          });
          res.json({ ok: true, targetId: tab.targetId });
        },
      });
    }),
  );

  app.post(
    "/trace/stop",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      const out = toStringOrEmpty(body.path) || "";

      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "trace stop",
        run: async ({ cdpUrl, tab, pw }) => {
          const id = crypto.randomUUID();
          const tracePath = await resolveWritableOutputPathOrRespond({
            res,
            rootDir: DEFAULT_TRACE_DIR,
            requestedPath: out,
            scopeLabel: "trace directory",
            defaultFileName: `browser-trace-${id}.zip`,
            ensureRootDir: true,
          });
          if (!tracePath) {
            return;
          }
          await pw.traceStopViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            path: tracePath,
          });
          res.json({
            ok: true,
            targetId: tab.targetId,
            path: path.resolve(tracePath),
          });
        },
      });
    }),
  );
}
