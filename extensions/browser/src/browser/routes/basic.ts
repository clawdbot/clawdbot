import { snapshotAria } from "../cdp.js";
import { getChromeMcpPid } from "../chrome-mcp.js";
import { resolveBrowserExecutableForPlatform } from "../chrome.executables.js";
import { resolveManagedBrowserHeadlessMode } from "../config.js";
import { buildBrowserDoctorReport } from "../doctor.js";
import { BrowserError, toBrowserErrorResponse } from "../errors.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import { createBrowserProfilesService } from "../profiles-service.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import { resolveProfileContext } from "./agent.shared.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import {
  asyncBrowserRoute,
  getProfileContext,
  jsonError,
  toBoolean,
  toStringOrEmpty,
} from "./utils.js";

function handleBrowserRouteError(res: BrowserResponse, err: unknown) {
  const mapped = toBrowserErrorResponse(err);
  if (mapped) {
    return jsonError(res, mapped.status, mapped.message);
  }
  jsonError(res, 500, String(err));
}

async function withBasicProfileRoute(params: {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  run: (profileCtx: ProfileContext) => Promise<void>;
}) {
  const profileCtx = resolveProfileContext(params.req, params.res, params.ctx);
  if (!profileCtx) {
    return;
  }
  try {
    await params.run(profileCtx);
  } catch (err) {
    return handleBrowserRouteError(params.res, err);
  }
}

async function withProfilesServiceMutation(params: {
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  run: (service: ReturnType<typeof createBrowserProfilesService>) => Promise<unknown>;
}) {
  try {
    const service = createBrowserProfilesService(params.ctx);
    const result = await params.run(service);
    params.res.json(result);
  } catch (err) {
    return handleBrowserRouteError(params.res, err);
  }
}

async function buildBrowserStatus(req: BrowserRequest, ctx: BrowserRouteContext) {
  let current: ReturnType<typeof ctx.state>;
  try {
    current = ctx.state();
  } catch {
    throw new BrowserError("browser server not started", 503);
  }

  const profileCtx = getProfileContext(req, ctx);
  if ("error" in profileCtx) {
    throw new BrowserError(profileCtx.error, profileCtx.status);
  }

  const capabilities = getBrowserProfileCapabilities(profileCtx.profile);
  const [cdpHttp, cdpReady] = capabilities.usesChromeMcp
    ? await (async () => {
        const ready = await profileCtx.isTransportAvailable(600);
        return [ready, ready] as const;
      })()
    : await Promise.all([profileCtx.isHttpReachable(300), profileCtx.isTransportAvailable(600)]);

  const profileState = current.profiles.get(profileCtx.profile.name);
  let detectedBrowser: string | null = null;
  let detectedExecutablePath: string | null = null;
  let detectError: string | null = null;

  try {
    const detected = resolveBrowserExecutableForPlatform(current.resolved, process.platform);
    if (detected) {
      detectedBrowser = detected.kind;
      detectedExecutablePath = detected.path;
    }
  } catch (err) {
    detectError = String(err);
  }
  const configuredHeadlessMode = resolveManagedBrowserHeadlessMode(
    current.resolved,
    profileCtx.profile,
  );
  const headlessMode =
    typeof profileState?.running?.headless === "boolean"
      ? {
          headless: profileState.running.headless,
          source: profileState.running.headlessSource ?? configuredHeadlessMode.source,
        }
      : configuredHeadlessMode;

  return {
    enabled: current.resolved.enabled,
    profile: profileCtx.profile.name,
    driver: profileCtx.profile.driver,
    transport: capabilities.usesChromeMcp ? ("chrome-mcp" as const) : ("cdp" as const),
    running: cdpReady,
    cdpReady,
    cdpHttp,
    pid: capabilities.usesChromeMcp
      ? getChromeMcpPid(profileCtx.profile.name)
      : (profileState?.running?.pid ?? null),
    cdpPort: capabilities.usesChromeMcp ? null : profileCtx.profile.cdpPort,
    cdpUrl: capabilities.usesChromeMcp ? null : profileCtx.profile.cdpUrl,
    chosenBrowser: profileState?.running?.exe.kind ?? null,
    detectedBrowser,
    detectedExecutablePath,
    detectError,
    userDataDir: profileState?.running?.userDataDir ?? profileCtx.profile.userDataDir ?? null,
    color: profileCtx.profile.color,
    headless: headlessMode.headless,
    headlessSource: headlessMode.source,
    noSandbox: current.resolved.noSandbox,
    executablePath: profileCtx.profile.executablePath ?? null,
    attachOnly: profileCtx.profile.attachOnly,
  };
}

async function runBrowserLiveProbe(req: BrowserRequest, ctx: BrowserRouteContext) {
  const profileCtx = getProfileContext(req, ctx);
  if ("error" in profileCtx) {
    return {
      id: "live-snapshot",
      label: "Live snapshot",
      status: "fail" as const,
      summary: profileCtx.error,
    };
  }
  const capabilities = getBrowserProfileCapabilities(profileCtx.profile);
  try {
    const tab = await profileCtx.ensureTabAvailable();
    if (capabilities.usesChromeMcp) {
      const { takeChromeMcpSnapshot } = await import("../chrome-mcp.js");
      await takeChromeMcpSnapshot({
        profileName: profileCtx.profile.name,
        profile: profileCtx.profile,
        targetId: tab.targetId,
      });
      return {
        id: "live-snapshot",
        label: "Live snapshot",
        status: "pass" as const,
        summary: `Chrome MCP snapshot succeeded on ${tab.suggestedTargetId ?? tab.targetId}`,
      };
    }
    if (!tab.wsUrl) {
      return {
        id: "live-snapshot",
        label: "Live snapshot",
        status: "warn" as const,
        summary: "No per-tab CDP WebSocket available for the lightweight live snapshot probe",
      };
    }
    const snap = await snapshotAria({ wsUrl: tab.wsUrl, limit: 25 });
    return {
      id: "live-snapshot",
      label: "Live snapshot",
      status: snap.nodes.length > 0 ? ("pass" as const) : ("warn" as const),
      summary:
        snap.nodes.length > 0
          ? `CDP accessibility snapshot returned ${snap.nodes.length} nodes on ${tab.suggestedTargetId ?? tab.targetId}`
          : `CDP accessibility snapshot returned no nodes on ${tab.suggestedTargetId ?? tab.targetId}`,
    };
  } catch (err) {
    return {
      id: "live-snapshot",
      label: "Live snapshot",
      status: "fail" as const,
      summary: String(err),
      fixHint: "Run openclaw browser start, then retry with openclaw browser doctor --deep.",
    };
  }
}

function hasQueryKey(query: BrowserRequest["query"], key: string): boolean {
  return Object.prototype.hasOwnProperty.call(query ?? {}, key);
}

function parseHeadlessStartOverride(params: {
  req: BrowserRequest;
  res: BrowserResponse;
  profileCtx: ProfileContext;
}): { ok: true; headless?: boolean } | { ok: false } {
  if (!hasQueryKey(params.req.query, "headless")) {
    return { ok: true };
  }

  const headless = toBoolean(params.req.query.headless);
  if (typeof headless !== "boolean") {
    jsonError(params.res, 400, 'Invalid headless value. Use "true" or "false".');
    return { ok: false };
  }

  const capabilities = getBrowserProfileCapabilities(params.profileCtx.profile);
  if (
    params.profileCtx.profile.driver !== "openclaw" ||
    params.profileCtx.profile.attachOnly ||
    capabilities.isRemote
  ) {
    jsonError(
      params.res,
      400,
      `Headless start override is only supported for locally launched openclaw profiles. Profile "${params.profileCtx.profile.name}" is attach-only, remote, or existing-session.`,
    );
    return { ok: false };
  }

  return { ok: true, headless };
}

export function registerBrowserBasicRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  // List all profiles with their status
  app.get(
    "/profiles",
    asyncBrowserRoute(async (_req, res) => {
      try {
        const service = createBrowserProfilesService(ctx);
        const profiles = await service.listProfiles();
        res.json({ profiles });
      } catch (err) {
        jsonError(res, 500, String(err));
      }
    }),
  );

  // Get status (profile-aware)
  app.get(
    "/",
    asyncBrowserRoute(async (req, res) => {
      try {
        res.json(await buildBrowserStatus(req, ctx));
      } catch (err) {
        const mapped = toBrowserErrorResponse(err);
        if (mapped) {
          return jsonError(res, mapped.status, mapped.message);
        }
        jsonError(res, 500, String(err));
      }
    }),
  );

  app.get(
    "/doctor",
    asyncBrowserRoute(async (req, res) => {
      try {
        const status = await buildBrowserStatus(req, ctx);
        const report = buildBrowserDoctorReport({ status });
        if (toBoolean(req.query.deep) === true || toBoolean(req.query.live) === true) {
          report.checks.push(await runBrowserLiveProbe(req, ctx));
          report.ok = report.checks.every((check) => check.status !== "fail");
        }
        res.json(report);
      } catch (err) {
        const mapped = toBrowserErrorResponse(err);
        if (mapped) {
          return jsonError(res, mapped.status, mapped.message);
        }
        jsonError(res, 500, String(err));
      }
    }),
  );

  // Start browser (profile-aware)
  app.post(
    "/start",
    asyncBrowserRoute(async (req, res) => {
      await withBasicProfileRoute({
        req,
        res,
        ctx,
        run: async (profileCtx) => {
          const headlessOverride = parseHeadlessStartOverride({ req, res, profileCtx });
          if (!headlessOverride.ok) {
            return;
          }
          await profileCtx.ensureBrowserAvailable({ headless: headlessOverride.headless });
          res.json({ ok: true, profile: profileCtx.profile.name });
        },
      });
    }),
  );

  // Stop browser (profile-aware)
  app.post(
    "/stop",
    asyncBrowserRoute(async (req, res) => {
      await withBasicProfileRoute({
        req,
        res,
        ctx,
        run: async (profileCtx) => {
          const result = await profileCtx.stopRunningBrowser();
          res.json({
            ok: true,
            stopped: result.stopped,
            profile: profileCtx.profile.name,
          });
        },
      });
    }),
  );

  // Reset profile (profile-aware)
  app.post(
    "/reset-profile",
    asyncBrowserRoute(async (req, res) => {
      await withBasicProfileRoute({
        req,
        res,
        ctx,
        run: async (profileCtx) => {
          const result = await profileCtx.resetProfile();
          res.json({ ok: true, profile: profileCtx.profile.name, ...result });
        },
      });
    }),
  );

  // Create a new profile
  app.post(
    "/profiles/create",
    asyncBrowserRoute(async (req, res) => {
      const name = toStringOrEmpty((req.body as { name?: unknown })?.name);
      const color = toStringOrEmpty((req.body as { color?: unknown })?.color);
      const cdpUrl = toStringOrEmpty((req.body as { cdpUrl?: unknown })?.cdpUrl);
      const userDataDir = toStringOrEmpty((req.body as { userDataDir?: unknown })?.userDataDir);
      const driver = toStringOrEmpty((req.body as { driver?: unknown })?.driver);

      if (!name) {
        return jsonError(res, 400, "name is required");
      }
      if (driver && driver !== "openclaw" && driver !== "clawd" && driver !== "existing-session") {
        return jsonError(
          res,
          400,
          `unsupported profile driver "${driver}"; use "openclaw", "clawd", or "existing-session"`,
        );
      }

      await withProfilesServiceMutation({
        res,
        ctx,
        run: async (service) =>
          await service.createProfile({
            name,
            color: color || undefined,
            cdpUrl: cdpUrl || undefined,
            userDataDir: userDataDir || undefined,
            driver:
              driver === "existing-session"
                ? "existing-session"
                : driver === "openclaw" || driver === "clawd"
                  ? "openclaw"
                  : undefined,
          }),
      });
    }),
  );

  // Delete a profile
  app.delete(
    "/profiles/:name",
    asyncBrowserRoute(async (req, res) => {
      const name = toStringOrEmpty(req.params.name);
      if (!name) {
        return jsonError(res, 400, "profile name is required");
      }

      await withProfilesServiceMutation({
        res,
        ctx,
        run: async (service) => await service.deleteProfile(name),
      });
    }),
  );
}
