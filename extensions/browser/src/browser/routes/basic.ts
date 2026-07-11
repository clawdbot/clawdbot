/**
 * Basic browser control routes.
 *
 * Serves status, doctor, start/stop, profile management, and simple health
 * endpoints for the browser control server.
 */
import { redactCdpUrl } from "../cdp.helpers.js";
import { snapshotAria } from "../cdp.js";
import { getChromeMcpPid, takeChromeMcpSnapshot } from "../chrome-mcp.js";
import { resolveBrowserExecutableForPlatform } from "../chrome.executables.js";
import {
  getCachedChromeGraphicsDiagnostics,
  inspectChromeGraphicsDiagnostics,
} from "../chrome.graphics.js";
import { resolveManagedBrowserHeadlessMode } from "../config.js";
import { buildBrowserDoctorReport } from "../doctor.js";
import { BrowserError, toBrowserErrorResponse } from "../errors.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import { createBrowserProfilesService } from "../profiles-service.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import { getProfileLifecycle, isProfileRestartRequiredError } from "../server-context.lifecycle.js";
import { parseSystemProfileDomains } from "../system-profile-domains.js";
import { dismissSystemProfileImportPrompt } from "../system-profile-import-state.js";
import { resolveProfileContext } from "./agent.shared.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import {
  asyncBrowserRoute,
  jsonBrowserError,
  jsonError,
  runProfileRouteOperation,
  toBoolean,
  toStringOrEmpty,
} from "./utils.js";

const STATUS_CDP_HTTP_TIMEOUT_MS = 300;
const STATUS_CDP_TRANSPORT_TIMEOUT_MS = 600;
const STATUS_GRAPHICS_COMMAND_TIMEOUT_MS = 1_000;
const STATUS_CHROME_MCP_TOTAL_TIMEOUT_MS = 7_000;
const STATUS_CHROME_MCP_TRANSPORT_TIMEOUT_MS = 5_000;

function remainingChromeMcpStatusTimeoutMs(startedAtMs: number): number {
  return Math.max(1, STATUS_CHROME_MCP_TOTAL_TIMEOUT_MS - (Date.now() - startedAtMs));
}

async function probeChromeMcpPageReady(profileCtx: ProfileContext, timeoutMs: number) {
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort(new Error(`Chrome MCP page-readiness probe timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  try {
    return await profileCtx.isReachable(timeoutMs, {
      ephemeral: true,
      signal: abort.signal,
    });
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function handleBrowserRouteError(res: BrowserResponse, err: unknown) {
  if (isProfileRestartRequiredError(err)) {
    throw err;
  }
  const mapped = toBrowserErrorResponse(err);
  if (mapped) {
    return jsonBrowserError(res, mapped);
  }
  jsonError(res, 500, String(err));
}

async function sendBasicJsonResponse(params: {
  res: BrowserResponse;
  run: () => Promise<unknown>;
}) {
  try {
    params.res.json(await params.run());
  } catch (err) {
    return handleBrowserRouteError(params.res, err);
  }
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

function registerBasicProfilePost(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
  path: string,
  run: (params: {
    req: BrowserRequest;
    res: BrowserResponse;
    profileCtx: ProfileContext;
  }) => Promise<void>,
) {
  app.post(
    path,
    asyncBrowserRoute(async (req, res) => {
      await withBasicProfileRoute({
        req,
        res,
        ctx,
        run: async (profileCtx) => await run({ req, res, profileCtx }),
      });
    }),
  );
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

async function buildBrowserStatus(
  ctx: BrowserRouteContext,
  profileCtx: ProfileContext,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let current: ReturnType<typeof ctx.state>;
  try {
    current = ctx.state();
  } catch {
    throw new BrowserError("browser server not started", 503);
  }

  const capabilities = getBrowserProfileCapabilities(profileCtx.profile);
  const [cdpHttp, cdpReady, pageReady] = capabilities.usesChromeMcp
    ? await (async () => {
        const statusStartedAtMs = Date.now();
        const transportReady = await profileCtx.isTransportAvailable(
          STATUS_CHROME_MCP_TRANSPORT_TIMEOUT_MS,
        );
        if (!transportReady) {
          return [false, false, false] as const;
        }
        // Status-safe page probe: ephemeral so a passive status call does not seed
        // a persistent cached Chrome MCP session. Keep the whole status route inside
        // the public client timeout; page probe failures degrade to pageReady=false.
        const pageReachable = await probeChromeMcpPageReady(
          profileCtx,
          remainingChromeMcpStatusTimeoutMs(statusStartedAtMs),
        );
        return [transportReady, transportReady, pageReachable] as const;
      })()
    : await (async () => {
        const [http, ready] = await Promise.all([
          profileCtx.isHttpReachable(STATUS_CDP_HTTP_TIMEOUT_MS),
          profileCtx.isTransportAvailable(STATUS_CDP_TRANSPORT_TIMEOUT_MS),
        ]);
        // For managed CDP profiles, the transport check already includes a WS
        // handshake against the page, so pageReady mirrors cdpReady.
        return [http, ready, ready] as const;
      })();

  const profileState = current.profiles.get(profileCtx.profile.name);
  const lifecycle = profileState ? getProfileLifecycle(profileState) : null;
  const running = profileState?.running;
  const canInspectManagedGraphics =
    capabilities.mode === "local-managed" &&
    cdpReady &&
    running &&
    !lifecycle?.transitionReason &&
    !lifecycle?.blockedReason &&
    running.cdpPort === profileCtx.profile.cdpPort;
  const graphics = canInspectManagedGraphics
    ? await getCachedChromeGraphicsDiagnostics(
        running,
        async () =>
          await inspectChromeGraphicsDiagnostics(`http://127.0.0.1:${running.cdpPort}`, {
            httpTimeoutMs: STATUS_CDP_HTTP_TIMEOUT_MS,
            handshakeTimeoutMs: STATUS_CDP_TRANSPORT_TIMEOUT_MS,
            commandTimeoutMs: STATUS_GRAPHICS_COMMAND_TIMEOUT_MS,
            ssrfPolicy: current.resolved.ssrfPolicy,
          }),
      )
    : null;
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

  signal.throwIfAborted();

  return {
    enabled: current.resolved.enabled,
    profile: profileCtx.profile.name,
    driver: profileCtx.profile.driver,
    transport: capabilities.usesChromeMcp
      ? ("chrome-mcp" as const)
      : capabilities.mode === "local-extension"
        ? ("extension" as const)
        : ("cdp" as const),
    running: cdpReady,
    cdpReady,
    cdpHttp,
    pageReady,
    pid: capabilities.usesChromeMcp
      ? getChromeMcpPid(profileCtx.profile.name)
      : (profileState?.running?.pid ?? null),
    cdpPort: capabilities.usesChromeMcp ? null : profileCtx.profile.cdpPort,
    cdpUrl: profileCtx.profile.cdpUrl ? (redactCdpUrl(profileCtx.profile.cdpUrl) ?? null) : null,
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
    graphics,
  };
}

async function runBrowserLiveProbe(profileCtx: ProfileContext, signal: AbortSignal) {
  const capabilities = getBrowserProfileCapabilities(profileCtx.profile);
  try {
    const tab = await profileCtx.ensureTabAvailable(undefined, { signal });
    if (capabilities.usesChromeMcp) {
      await takeChromeMcpSnapshot({
        profileName: profileCtx.profile.name,
        profile: profileCtx.profile,
        targetId: tab.targetId,
        signal,
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
    if (isProfileRestartRequiredError(err)) {
      throw err;
    }
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
  return Object.hasOwn(query ?? {}, key);
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

/** Register basic browser lifecycle, status, doctor, and profile endpoints. */
export function registerBrowserBasicRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  app.get(
    "/system-profiles",
    asyncBrowserRoute(async (req, res) => {
      await sendBasicJsonResponse({
        res,
        run: async () => {
          const service = createBrowserProfilesService(ctx);
          return {
            systemProfiles: await service.listSystemProfiles(
              toStringOrEmpty(req.query.browser) || undefined,
            ),
          };
        },
      });
    }),
  );

  app.get(
    "/system-profile-import/status",
    asyncBrowserRoute(async (_req, res) => {
      await sendBasicJsonResponse({
        res,
        run: async () => await createBrowserProfilesService(ctx).getSystemProfileImportStatus(),
      });
    }),
  );

  app.post(
    "/system-profile-import/dismiss",
    asyncBrowserRoute(async (_req, res) => {
      await sendBasicJsonResponse({
        res,
        run: async () => {
          await dismissSystemProfileImportPrompt();
          return { ok: true };
        },
      });
    }),
  );

  // List all profiles with their status
  app.get(
    "/profiles",
    asyncBrowserRoute(async (_req, res) => {
      try {
        const service = createBrowserProfilesService(ctx);
        const profiles = await service.listProfiles();
        res.json({ profiles });
      } catch (err) {
        return handleBrowserRouteError(res, err);
      }
    }),
  );

  // Get status (profile-aware)
  app.get(
    "/",
    asyncBrowserRoute(async (req, res) => {
      const profileCtx = resolveProfileContext(req, res, ctx);
      if (!profileCtx) {
        return;
      }
      try {
        const status = await runProfileRouteOperation({
          profileCtx,
          signal: req.signal,
          run: async (signal) => await buildBrowserStatus(ctx, profileCtx, signal),
        });
        res.json(status);
      } catch (err) {
        return handleBrowserRouteError(res, err);
      }
    }),
  );

  app.get(
    "/doctor",
    asyncBrowserRoute(async (req, res) => {
      const profileCtx = resolveProfileContext(req, res, ctx);
      if (!profileCtx) {
        return;
      }
      try {
        const report = await runProfileRouteOperation({
          profileCtx,
          signal: req.signal,
          run: async (signal) => {
            const status = await buildBrowserStatus(ctx, profileCtx, signal);
            const doctorReport = buildBrowserDoctorReport({ status });
            if (toBoolean(req.query.deep) === true || toBoolean(req.query.live) === true) {
              doctorReport.checks.push(await runBrowserLiveProbe(profileCtx, signal));
              doctorReport.ok = doctorReport.checks.every((check) => check.status !== "fail");
            }
            return doctorReport;
          },
        });
        res.json(report);
      } catch (err) {
        return handleBrowserRouteError(res, err);
      }
    }),
  );

  // Start browser (profile-aware)
  registerBasicProfilePost(app, ctx, "/start", async ({ req, res, profileCtx }) => {
    const headlessOverride = parseHeadlessStartOverride({ req, res, profileCtx });
    if (!headlessOverride.ok) {
      return;
    }
    await profileCtx.ensureBrowserAvailable({
      headless: headlessOverride.headless,
      ...(req.signal ? { signal: req.signal } : {}),
    });
    res.json({ ok: true, profile: profileCtx.profile.name });
  });

  // Stop browser (profile-aware)
  registerBasicProfilePost(app, ctx, "/stop", async ({ res, profileCtx }) => {
    const result = await profileCtx.stopRunningBrowser();
    res.json({
      ok: true,
      stopped: result.stopped,
      profile: profileCtx.profile.name,
    });
  });

  // Reset profile (profile-aware)
  registerBasicProfilePost(app, ctx, "/reset-profile", async ({ res, profileCtx }) => {
    const result = await profileCtx.resetProfile();
    res.json({ ok: true, profile: profileCtx.profile.name, ...result });
  });

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

  app.post(
    "/profiles/import",
    asyncBrowserRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Fail closed on a malformed domain filter: a caller that meant to scope
      // the import must never silently import every cookie instead.
      let domains: string[] | undefined;
      try {
        domains = parseSystemProfileDomains(body.domains);
      } catch (err) {
        return jsonError(res, 400, err instanceof Error ? err.message : "invalid domains");
      }
      try {
        const service = createBrowserProfilesService(ctx);
        const result = await service.importSystemProfile(
          {
            browser: toStringOrEmpty(body.browser) || undefined,
            systemProfile: toStringOrEmpty(body.systemProfile) || undefined,
            into: toStringOrEmpty(body.into) || undefined,
            domains,
            makeDefault: toBoolean(body.makeDefault) ?? false,
          },
          { signal: req.signal },
        );
        res.json(result);
      } catch (err) {
        return handleBrowserRouteError(res, err);
      }
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
