import {
  BrowserProfileUnavailableError,
  BrowserTabNotFoundError,
  BrowserTargetAmbiguousError,
} from "../errors.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed,
  withBrowserNavigationPolicy,
} from "../navigation-guard.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import { resolveTargetIdFromTabs } from "../target-id.js";
import { browserNavigationPolicyForProfile, resolveProfileContext } from "./agent.shared.js";
import { readRouteNonNegativeInteger } from "./route-numeric.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import { asyncBrowserRoute, jsonError, toStringOrEmpty } from "./utils.js";

function handleTabsRouteError(
  ctx: BrowserRouteContext,
  res: BrowserResponse,
  err: unknown,
  opts?: { mapTabError?: boolean },
) {
  if (opts?.mapTabError) {
    const mapped = ctx.mapTabError(err);
    if (mapped) {
      return jsonError(res, mapped.status, mapped.message);
    }
  }
  return jsonError(res, 500, String(err));
}

async function withTabsProfileRoute(params: {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  mapTabError?: boolean;
  run: (profileCtx: ProfileContext) => Promise<void>;
}) {
  const profileCtx = resolveProfileContext(params.req, params.res, params.ctx);
  if (!profileCtx) {
    return;
  }
  try {
    await params.run(profileCtx);
  } catch (err) {
    handleTabsRouteError(params.ctx, params.res, err, { mapTabError: params.mapTabError });
  }
}

async function ensureBrowserRunning(profileCtx: ProfileContext, res: BrowserResponse) {
  if (!(await profileCtx.isReachable(300))) {
    jsonError(
      res,
      new BrowserProfileUnavailableError("browser not running").status,
      "browser not running",
    );
    return false;
  }
  return true;
}

async function redactBlockedTabUrls(params: {
  tabs: Awaited<ReturnType<ProfileContext["listTabs"]>>;
  ssrfPolicy: ReturnType<BrowserRouteContext["state"]>["resolved"]["ssrfPolicy"];
}): Promise<Awaited<ReturnType<ProfileContext["listTabs"]>>> {
  const ssrfPolicyOpts = withBrowserNavigationPolicy(params.ssrfPolicy);
  if (!ssrfPolicyOpts.ssrfPolicy) {
    return params.tabs;
  }

  const redactedTabs: Awaited<ReturnType<ProfileContext["listTabs"]>> = [];
  for (const tab of params.tabs) {
    try {
      await assertBrowserNavigationResultAllowed({
        url: tab.url,
        ...ssrfPolicyOpts,
      });
      redactedTabs.push(tab);
    } catch {
      // Hide blocked URLs while preserving tab identity for safe operations.
      redactedTabs.push({
        ...tab,
        url: "",
      });
    }
  }
  return redactedTabs;
}

function resolveIndexedTab(
  tabs: Awaited<ReturnType<ProfileContext["listTabs"]>>,
  index: number | undefined,
) {
  return typeof index === "number" ? tabs[index] : tabs.at(0);
}

function parseRequiredTargetId(res: BrowserResponse, rawTargetId: unknown): string | null {
  const targetId = toStringOrEmpty(rawTargetId);
  if (!targetId) {
    jsonError(res, 400, "targetId is required");
    return null;
  }
  return targetId;
}

function readOptionalTabLabel(body: unknown): string | undefined {
  const label = toStringOrEmpty((body as { label?: unknown })?.label);
  return label || undefined;
}

function readTabIndex(
  res: BrowserResponse,
  body: unknown,
  opts?: { required?: boolean },
): number | null | undefined {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (!Object.hasOwn(record, "index")) {
    if (opts?.required) {
      jsonError(res, 400, "index is required");
      return null;
    }
    return undefined;
  }
  if (record.index == null) {
    jsonError(res, 400, "index must be a non-negative integer");
    return null;
  }
  try {
    return readRouteNonNegativeInteger(record.index, "index", {
      invalidMessage: "index must be a non-negative integer",
    });
  } catch (error) {
    jsonError(res, 400, error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function runTabTargetMutation(params: {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  targetId: string;
  mutate: (profileCtx: ProfileContext, targetId: string) => Promise<void>;
}) {
  await withTabsProfileRoute({
    req: params.req,
    res: params.res,
    ctx: params.ctx,
    mapTabError: true,
    run: async (profileCtx) => {
      if (!(await ensureBrowserRunning(profileCtx, params.res))) {
        return;
      }
      await params.mutate(profileCtx, params.targetId);
      params.res.json({ ok: true });
    },
  });
}

export function registerBrowserTabRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  app.get(
    "/tabs",
    asyncBrowserRoute(async (req, res) => {
      await withTabsProfileRoute({
        req,
        res,
        ctx,
        run: async (profileCtx) => {
          const reachable = await profileCtx.isReachable(300);
          if (!reachable) {
            return res.json({ running: false, tabs: [] as unknown[] });
          }
          const tabs = await redactBlockedTabUrls({
            tabs: await profileCtx.listTabs(),
            ssrfPolicy: ctx.state().resolved.ssrfPolicy,
          });
          res.json({ running: true, tabs });
        },
      });
    }),
  );

  app.post(
    "/tabs/open",
    asyncBrowserRoute(async (req, res) => {
      const url = toStringOrEmpty((req.body as { url?: unknown })?.url);
      const label = readOptionalTabLabel(req.body);
      if (!url) {
        return jsonError(res, 400, "url is required");
      }

      await withTabsProfileRoute({
        req,
        res,
        ctx,
        mapTabError: true,
        run: async (profileCtx) => {
          await assertBrowserNavigationAllowed({
            url,
            ...browserNavigationPolicyForProfile(ctx, profileCtx),
          });
          await profileCtx.ensureBrowserAvailable();
          const tab = await profileCtx.openTab(url, { label });
          res.json(tab);
        },
      });
    }),
  );

  app.post(
    "/tabs/focus",
    asyncBrowserRoute(async (req, res) => {
      const targetId = parseRequiredTargetId(res, (req.body as { targetId?: unknown })?.targetId);
      if (!targetId) {
        return;
      }
      await runTabTargetMutation({
        req,
        res,
        ctx,
        targetId,
        mutate: async (profileCtx, id) => {
          const tabs = await profileCtx.listTabs();
          const resolved = resolveTargetIdFromTabs(id, tabs);
          if (!resolved.ok) {
            if (resolved.reason === "ambiguous") {
              throw new BrowserTargetAmbiguousError();
            }
            throw new BrowserTabNotFoundError({ input: id });
          }
          const tab = tabs.find((currentTab) => currentTab.targetId === resolved.targetId);
          if (!tab) {
            throw new BrowserTabNotFoundError({ input: id });
          }
          const ssrfPolicyOpts = browserNavigationPolicyForProfile(ctx, profileCtx);
          if (ssrfPolicyOpts.ssrfPolicy) {
            await assertBrowserNavigationResultAllowed({
              url: tab.url,
              ...ssrfPolicyOpts,
            });
          }
          await profileCtx.focusTab(resolved.targetId);
        },
      });
    }),
  );

  app.delete(
    "/tabs/:targetId",
    asyncBrowserRoute(async (req, res) => {
      const targetId = parseRequiredTargetId(res, req.params.targetId);
      if (!targetId) {
        return;
      }
      await runTabTargetMutation({
        req,
        res,
        ctx,
        targetId,
        mutate: async (profileCtx, id) => {
          await profileCtx.closeTab(id);
        },
      });
    }),
  );

  app.post(
    "/tabs/action",
    asyncBrowserRoute(async (req, res) => {
      const action = toStringOrEmpty((req.body as { action?: unknown })?.action);

      await withTabsProfileRoute({
        req,
        res,
        ctx,
        mapTabError: true,
        run: async (profileCtx) => {
          if (action === "list") {
            const reachable = await profileCtx.isReachable(300);
            if (!reachable) {
              return res.json({ ok: true, tabs: [] as unknown[] });
            }
            const tabs = await redactBlockedTabUrls({
              tabs: await profileCtx.listTabs(),
              ssrfPolicy: ctx.state().resolved.ssrfPolicy,
            });
            return res.json({ ok: true, tabs });
          }

          if (action === "new") {
            await profileCtx.ensureBrowserAvailable();
            const tab = await profileCtx.openTab("about:blank", {
              label: readOptionalTabLabel(req.body),
            });
            return res.json({ ok: true, tab });
          }

          if (action === "label") {
            if (!(await ensureBrowserRunning(profileCtx, res))) {
              return;
            }
            const targetId = parseRequiredTargetId(
              res,
              (req.body as { targetId?: unknown })?.targetId,
            );
            if (!targetId) {
              return;
            }
            const label = readOptionalTabLabel(req.body);
            if (!label) {
              return jsonError(res, 400, "label is required");
            }
            const tab = await profileCtx.labelTab(targetId, label);
            return res.json({ ok: true, tab });
          }

          if (action === "close") {
            if (!(await ensureBrowserRunning(profileCtx, res))) {
              return;
            }
            const index = readTabIndex(res, req.body);
            if (index === null) {
              return;
            }
            const tabs = await profileCtx.listTabs();
            const target = resolveIndexedTab(tabs, index);
            if (!target) {
              throw new BrowserTabNotFoundError();
            }
            await profileCtx.closeTab(target.targetId);
            return res.json({ ok: true, targetId: target.targetId });
          }

          if (action === "select") {
            const index = readTabIndex(res, req.body, { required: true });
            if (index === null || index === undefined) {
              return;
            }
            if (!(await ensureBrowserRunning(profileCtx, res))) {
              return;
            }
            const tabs = await profileCtx.listTabs();
            const target = tabs[index];
            if (!target) {
              throw new BrowserTabNotFoundError();
            }
            const ssrfPolicyOpts = browserNavigationPolicyForProfile(ctx, profileCtx);
            if (ssrfPolicyOpts.ssrfPolicy) {
              await assertBrowserNavigationResultAllowed({
                url: target.url,
                ...ssrfPolicyOpts,
              });
            }
            await profileCtx.focusTab(target.targetId);
            return res.json({ ok: true, targetId: target.targetId });
          }

          return jsonError(res, 400, "unknown tab action");
        },
      });
    }),
  );
}
