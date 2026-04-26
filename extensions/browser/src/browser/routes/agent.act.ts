import { formatErrorMessage } from "../../infra/errors.js";
import {
  clickChromeMcpElement,
  clickChromeMcpCoords,
  closeChromeMcpTab,
  dragChromeMcpElement,
  evaluateChromeMcpScript,
  fillChromeMcpElement,
  fillChromeMcpForm,
  hoverChromeMcpElement,
  pressChromeMcpKey,
  resizeChromeMcpPage,
  type ChromeMcpProfileOptions,
} from "../chrome-mcp.js";
import type { BrowserActRequest } from "../client-actions.types.js";
import {
  assertBrowserNavigationResultAllowed,
  type BrowserNavigationPolicyOptions,
  withBrowserNavigationPolicy,
} from "../navigation-guard.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { BrowserRouteContext } from "../server-context.js";
import { matchBrowserUrlPattern } from "../url-pattern.js";
import { registerBrowserAgentActDownloadRoutes } from "./agent.act.download.js";
import {
  ACT_ERROR_CODES,
  browserEvaluateDisabledMessage,
  jsonActError,
} from "./agent.act.errors.js";
import { registerBrowserAgentActHookRoutes } from "./agent.act.hooks.js";
import { normalizeActRequest, validateBatchTargetIds } from "./agent.act.normalize.js";
import { type ActKind, isActKind } from "./agent.act.shared.js";
import {
  readBody,
  requirePwAi,
  resolveTargetIdFromBody,
  resolveSafeRouteTabUrl,
  withRouteTabContext,
  SELECTOR_UNSUPPORTED_MESSAGE,
} from "./agent.shared.js";
import { resolveTargetIdAfterNavigate } from "./agent.snapshot-target.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { asyncBrowserRoute, jsonError, toNumber, toStringOrEmpty } from "./utils.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const EXISTING_SESSION_INTERACTION_NAVIGATION_RECHECK_DELAYS_MS = [0, 250, 500] as const;

async function readExistingSessionLocationHref(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
}): Promise<string> {
  const currentUrl = await evaluateChromeMcpScript({
    profileName: params.profileName,
    profile: params.profile,
    userDataDir: params.userDataDir,
    targetId: params.targetId,
    fn: "() => window.location.href",
  });
  if (typeof currentUrl !== "string") {
    throw new Error("Location probe returned a non-string result");
  }
  const normalizedUrl = currentUrl.trim();
  if (!normalizedUrl) {
    throw new Error("Location probe returned an empty URL");
  }
  return normalizedUrl;
}

async function assertExistingSessionPostInteractionNavigationAllowed(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  ssrfPolicy?: BrowserNavigationPolicyOptions["ssrfPolicy"];
  listTabs: () => Promise<Array<{ targetId: string; url: string }>>;
  initialTabTargetIds: ReadonlySet<string>;
}): Promise<void> {
  const ssrfPolicyOpts = withBrowserNavigationPolicy(params.ssrfPolicy);
  if (!ssrfPolicyOpts.ssrfPolicy) {
    return;
  }
  const listTabs = params.listTabs;
  const initialTabTargetIds = params.initialTabTargetIds;

  const assertNewTabsAllowed = async () => {
    const tabs = await listTabs();
    for (const tab of tabs) {
      if (initialTabTargetIds.has(tab.targetId)) {
        continue;
      }
      await assertBrowserNavigationResultAllowed({
        url: tab.url,
        ...ssrfPolicyOpts,
      });
    }
  };

  let lastObservedUrl: string | undefined;
  let sawStableAllowedUrl = false;
  for (const delayMs of EXISTING_SESSION_INTERACTION_NAVIGATION_RECHECK_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    let currentUrl: string;
    try {
      currentUrl = await readExistingSessionLocationHref(params);
    } catch {
      sawStableAllowedUrl = false;
      continue;
    }
    await assertBrowserNavigationResultAllowed({
      url: currentUrl,
      ...ssrfPolicyOpts,
    });
    if (currentUrl === lastObservedUrl) {
      sawStableAllowedUrl = true;
    } else {
      sawStableAllowedUrl = false;
    }
    lastObservedUrl = currentUrl;
  }

  if (sawStableAllowedUrl) {
    await assertNewTabsAllowed();
    return;
  }

  // If the loop exhausted without confirming stability but we did observe
  // at least one allowed URL, run a single follow-up probe so a late URL
  // transition that has already settled is not treated as a false failure.
  if (lastObservedUrl) {
    const lastDelay =
      EXISTING_SESSION_INTERACTION_NAVIGATION_RECHECK_DELAYS_MS[
        EXISTING_SESSION_INTERACTION_NAVIGATION_RECHECK_DELAYS_MS.length - 1
      ];
    await sleep(lastDelay);
    try {
      const followUpUrl = await readExistingSessionLocationHref(params);
      await assertBrowserNavigationResultAllowed({
        url: followUpUrl,
        ...ssrfPolicyOpts,
      });
      if (followUpUrl === lastObservedUrl) {
        await assertNewTabsAllowed();
        return;
      }
    } catch {
      // Probe failed — fall through to throw
    }
  }

  throw new Error("Unable to verify stable post-interaction navigation");
}

async function runExistingSessionActionWithNavigationGuard<T>(params: {
  execute: () => Promise<T>;
  guard?: Parameters<typeof assertExistingSessionPostInteractionNavigationAllowed>[0];
}): Promise<T> {
  let actionError: unknown;
  let result: T | undefined;
  try {
    result = await params.execute();
  } catch (error) {
    actionError = error;
  }

  if (params.guard) {
    await assertExistingSessionPostInteractionNavigationAllowed(params.guard);
  }

  if (actionError) {
    throw actionError;
  }

  return result as T;
}

function buildExistingSessionWaitPredicate(params: {
  text?: string;
  textGone?: string;
  selector?: string;
  loadState?: "load" | "domcontentloaded" | "networkidle";
  fn?: string;
}): string | null {
  const checks: string[] = [];
  if (params.text) {
    checks.push(`Boolean(document.body?.innerText?.includes(${JSON.stringify(params.text)}))`);
  }
  if (params.textGone) {
    checks.push(`!document.body?.innerText?.includes(${JSON.stringify(params.textGone)})`);
  }
  if (params.selector) {
    checks.push(`Boolean(document.querySelector(${JSON.stringify(params.selector)}))`);
  }
  if (params.loadState === "domcontentloaded") {
    checks.push(`document.readyState === "interactive" || document.readyState === "complete"`);
  } else if (params.loadState === "load") {
    checks.push(`document.readyState === "complete"`);
  }
  if (params.fn) {
    checks.push(`Boolean(await (${params.fn})())`);
  }
  if (checks.length === 0) {
    return null;
  }
  return checks.length === 1 ? checks[0] : checks.map((check) => `(${check})`).join(" && ");
}

async function waitForExistingSessionCondition(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  timeMs?: number;
  text?: string;
  textGone?: string;
  selector?: string;
  url?: string;
  loadState?: "load" | "domcontentloaded" | "networkidle";
  fn?: string;
  timeoutMs?: number;
}): Promise<void> {
  if (params.timeMs && params.timeMs > 0) {
    await sleep(params.timeMs);
  }
  const predicate = buildExistingSessionWaitPredicate(params);
  if (!predicate && !params.url) {
    return;
  }
  const timeoutMs = Math.max(250, params.timeoutMs ?? 10_000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let ready = true;
    if (predicate) {
      ready = Boolean(
        await evaluateChromeMcpScript({
          profileName: params.profileName,
          profile: params.profile,
          userDataDir: params.userDataDir,
          targetId: params.targetId,
          fn: `async () => ${predicate}`,
        }),
      );
    }
    if (ready && params.url) {
      const currentUrl = await evaluateChromeMcpScript({
        profileName: params.profileName,
        profile: params.profile,
        userDataDir: params.userDataDir,
        targetId: params.targetId,
        fn: "() => window.location.href",
      });
      ready = typeof currentUrl === "string" && matchBrowserUrlPattern(params.url, currentUrl);
    }
    if (ready) {
      return;
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for condition");
}

const SELECTOR_ALLOWED_KINDS: ReadonlySet<string> = new Set([
  "batch",
  "click",
  "drag",
  "hover",
  "scrollIntoView",
  "select",
  "type",
  "wait",
]);
function getExistingSessionUnsupportedMessage(action: BrowserActRequest): string | null {
  switch (action.kind) {
    case "click":
      if (action.selector) {
        return EXISTING_SESSION_LIMITS.act.clickSelector;
      }
      if (
        (action.button && action.button !== "left") ||
        (Array.isArray(action.modifiers) && action.modifiers.length > 0)
      ) {
        return EXISTING_SESSION_LIMITS.act.clickButtonOrModifiers;
      }
      return null;
    case "clickCoords":
      return null;
    case "type":
      if (action.selector) {
        return EXISTING_SESSION_LIMITS.act.typeSelector;
      }
      if (action.slowly) {
        return EXISTING_SESSION_LIMITS.act.typeSlowly;
      }
      return action.timeoutMs ? EXISTING_SESSION_LIMITS.act.typeTimeout : null;
    case "press":
      return action.delayMs ? EXISTING_SESSION_LIMITS.act.pressDelay : null;
    case "hover":
      if (action.selector) {
        return EXISTING_SESSION_LIMITS.act.hoverSelector;
      }
      return action.timeoutMs ? EXISTING_SESSION_LIMITS.act.hoverTimeout : null;
    case "scrollIntoView":
      if (action.selector) {
        return EXISTING_SESSION_LIMITS.act.scrollSelector;
      }
      return action.timeoutMs ? EXISTING_SESSION_LIMITS.act.scrollTimeout : null;
    case "drag":
      if (action.startSelector || action.endSelector) {
        return EXISTING_SESSION_LIMITS.act.dragSelector;
      }
      return action.timeoutMs ? EXISTING_SESSION_LIMITS.act.dragTimeout : null;
    case "select":
      if (action.selector) {
        return EXISTING_SESSION_LIMITS.act.selectSelector;
      }
      if (action.values.length !== 1) {
        return EXISTING_SESSION_LIMITS.act.selectSingleValue;
      }
      return action.timeoutMs ? EXISTING_SESSION_LIMITS.act.selectTimeout : null;
    case "fill":
      return action.timeoutMs ? EXISTING_SESSION_LIMITS.act.fillTimeout : null;
    case "wait":
      return action.loadState === "networkidle"
        ? EXISTING_SESSION_LIMITS.act.waitNetworkIdle
        : null;
    case "evaluate":
      return action.timeoutMs !== undefined ? EXISTING_SESSION_LIMITS.act.evaluateTimeout : null;
    case "batch":
      return EXISTING_SESSION_LIMITS.act.batch;
    case "resize":
    case "close":
      return null;
  }
  throw new Error("Unsupported browser act kind");
}

export function registerBrowserAgentActRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post(
    "/act",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const kindRaw = toStringOrEmpty(body.kind);
      if (!isActKind(kindRaw)) {
        return jsonActError(res, 400, ACT_ERROR_CODES.kindRequired, "kind is required");
      }
      const kind: ActKind = kindRaw;
      let action: BrowserActRequest;
      try {
        action = normalizeActRequest(body);
      } catch (err) {
        return jsonActError(res, 400, ACT_ERROR_CODES.invalidRequest, formatErrorMessage(err));
      }
      const targetId = resolveTargetIdFromBody(body);
      if (Object.hasOwn(body, "selector") && !SELECTOR_ALLOWED_KINDS.has(kind)) {
        return jsonActError(
          res,
          400,
          ACT_ERROR_CODES.selectorUnsupported,
          SELECTOR_UNSUPPORTED_MESSAGE,
        );
      }
      const earlyFn = action.kind === "wait" || action.kind === "evaluate" ? action.fn : "";
      if (
        (action.kind === "evaluate" || (action.kind === "wait" && earlyFn)) &&
        !ctx.state().resolved.evaluateEnabled
      ) {
        return jsonActError(
          res,
          403,
          ACT_ERROR_CODES.evaluateDisabled,
          browserEvaluateDisabledMessage(action.kind === "evaluate" ? "evaluate" : "wait"),
        );
      }

      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId,
        run: async ({ profileCtx, cdpUrl, tab, resolveTabUrl }) => {
          const evaluateEnabled = ctx.state().resolved.evaluateEnabled;
          const ssrfPolicy = ctx.state().resolved.ssrfPolicy;
          const isExistingSession = getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp;
          const hasNavigationResultPolicy = Boolean(
            withBrowserNavigationPolicy(ssrfPolicy).ssrfPolicy,
          );
          const jsonOk = async (
            extra?: Record<string, unknown>,
            options?: { resolveCurrentTarget?: boolean },
          ) => {
            const shouldResolveCurrentTarget =
              options?.resolveCurrentTarget && (!isExistingSession || hasNavigationResultPolicy);
            const responseTargetId = shouldResolveCurrentTarget
              ? await resolveTargetIdAfterNavigate({
                  oldTargetId: tab.targetId,
                  navigatedUrl: tab.url,
                  listTabs: () => profileCtx.listTabs(),
                })
              : tab.targetId;
            const url =
              responseTargetId === tab.targetId
                ? await resolveTabUrl(tab.url)
                : await resolveSafeRouteTabUrl({
                    ctx,
                    profileCtx,
                    targetId: responseTargetId,
                    fallbackUrl: tab.url,
                  });
            return res.json({
              ok: true,
              targetId: responseTargetId,
              ...(url ? { url } : {}),
              ...extra,
            });
          };
          if (action.targetId && action.targetId !== tab.targetId) {
            return jsonActError(
              res,
              403,
              ACT_ERROR_CODES.targetIdMismatch,
              "action targetId must match request targetId",
            );
          }
          const profileName = profileCtx.profile.name;
          if (isExistingSession) {
            const initialTabTargetIds = hasNavigationResultPolicy
              ? new Set((await profileCtx.listTabs()).map((currentTab) => currentTab.targetId))
              : new Set<string>();
            const existingSessionNavigationGuard = {
              profileName,
              profile: profileCtx.profile,
              targetId: tab.targetId,
              ssrfPolicy,
              listTabs: () => profileCtx.listTabs(),
              initialTabTargetIds,
            };
            const unsupportedMessage = getExistingSessionUnsupportedMessage(action);
            if (unsupportedMessage) {
              return jsonActError(
                res,
                501,
                ACT_ERROR_CODES.unsupportedForExistingSession,
                unsupportedMessage,
              );
            }
            switch (action.kind) {
              case "click":
                await runExistingSessionActionWithNavigationGuard({
                  execute: () =>
                    clickChromeMcpElement({
                      profileName,
                      profile: profileCtx.profile,
                      targetId: tab.targetId,
                      uid: action.ref!,
                      doubleClick: action.doubleClick ?? false,
                      timeoutMs: action.timeoutMs,
                      signal: req.signal,
                    }),
                  guard: existingSessionNavigationGuard,
                });
                return await jsonOk(undefined, { resolveCurrentTarget: true });
              case "clickCoords":
                await runExistingSessionActionWithNavigationGuard({
                  execute: () =>
                    clickChromeMcpCoords({
                      profileName,
                      profile: profileCtx.profile,
                      targetId: tab.targetId,
                      x: action.x,
                      y: action.y,
                      doubleClick: action.doubleClick ?? false,
                      button: action.button as "left" | "right" | "middle" | undefined,
                      delayMs: action.delayMs,
                    }),
                  guard: existingSessionNavigationGuard,
                });
                return await jsonOk(undefined, { resolveCurrentTarget: true });
              case "type":
                await runExistingSessionActionWithNavigationGuard({
                  execute: async () => {
                    await fillChromeMcpElement({
                      profileName,
                      profile: profileCtx.profile,
                      targetId: tab.targetId,
                      uid: action.ref!,
                      value: action.text,
                    });
                    if (action.submit) {
                      await pressChromeMcpKey({
                        profileName,
                        profile: profileCtx.profile,
                        targetId: tab.targetId,
                        key: "Enter",
                      });
                    }
                  },
                  guard: existingSessionNavigationGuard,
                });
                return await jsonOk(undefined, { resolveCurrentTarget: true });
              case "press":
                await runExistingSessionActionWithNavigationGuard({
                  execute: () =>
                    pressChromeMcpKey({
                      profileName,
                      profile: profileCtx.profile,
                      targetId: tab.targetId,
                      key: action.key,
                    }),
                  guard: existingSessionNavigationGuard,
                });
                return await jsonOk(undefined, { resolveCurrentTarget: true });
              case "hover":
                await runExistingSessionActionWithNavigationGuard({
                  execute: () =>
                    hoverChromeMcpElement({
                      profileName,
                      profile: profileCtx.profile,
                      targetId: tab.targetId,
                      uid: action.ref!,
                    }),
                  guard: existingSessionNavigationGuard,
                });
                return await jsonOk();
              case "scrollIntoView":
                await runExistingSessionActionWithNavigationGuard({
                  execute: () =>
                    evaluateChromeMcpScript({
                      profileName,
                      profile: profileCtx.profile,
                      targetId: tab.targetId,
                      fn: `(el) => { el.scrollIntoView({ block: "center", inline: "center" }); return true; }`,
                      args: [action.ref!],
                    }),
                  guard: existingSessionNavigationGuard,
                });
                return await jsonOk();
              case "drag":
                await runExistingSessionActionWithNavigationGuard({
                  execute: () =>
                    dragChromeMcpElement({
                      profileName,
                      profile: profileCtx.profile,
                      targetId: tab.targetId,
                      fromUid: action.startRef!,
                      toUid: action.endRef!,
                    }),
                  guard: existingSessionNavigationGuard,
                });
                return await jsonOk();
              case "select":
                await runExistingSessionActionWithNavigationGuard({
                  execute: () =>
                    fillChromeMcpElement({
                      profileName,
                      profile: profileCtx.profile,
                      targetId: tab.targetId,
                      uid: action.ref!,
                      value: action.values[0] ?? "",
                    }),
                  guard: existingSessionNavigationGuard,
                });
                return await jsonOk();
              case "fill":
                await runExistingSessionActionWithNavigationGuard({
                  execute: () =>
                    fillChromeMcpForm({
                      profileName,
                      profile: profileCtx.profile,
                      targetId: tab.targetId,
                      elements: action.fields.map((field) => ({
                        uid: field.ref,
                        value: String(field.value ?? ""),
                      })),
                    }),
                  guard: existingSessionNavigationGuard,
                });
                return await jsonOk();
              case "resize":
                await resizeChromeMcpPage({
                  profileName,
                  profile: profileCtx.profile,
                  targetId: tab.targetId,
                  width: action.width,
                  height: action.height,
                });
                return await jsonOk();
              case "wait":
                await waitForExistingSessionCondition({
                  profileName,
                  profile: profileCtx.profile,
                  targetId: tab.targetId,
                  timeMs: action.timeMs,
                  text: action.text,
                  textGone: action.textGone,
                  selector: action.selector,
                  url: action.url,
                  loadState: action.loadState,
                  fn: action.fn,
                  timeoutMs: action.timeoutMs,
                });
                return await jsonOk();
              case "evaluate": {
                const result = await runExistingSessionActionWithNavigationGuard({
                  execute: () =>
                    evaluateChromeMcpScript({
                      profileName,
                      profile: profileCtx.profile,
                      targetId: tab.targetId,
                      fn: action.fn,
                      args: action.ref ? [action.ref] : undefined,
                    }),
                  guard: existingSessionNavigationGuard,
                });
                return await jsonOk({ result });
              }
              case "close":
                await closeChromeMcpTab(profileName, tab.targetId, profileCtx.profile);
                return await jsonOk();
              case "batch":
                return jsonActError(
                  res,
                  501,
                  ACT_ERROR_CODES.unsupportedForExistingSession,
                  EXISTING_SESSION_LIMITS.act.batch,
                );
            }
          }

          const pw = await requirePwAi(res, `act:${kind}`);
          if (!pw) {
            return;
          }
          if (action.kind === "batch") {
            const targetIdError = validateBatchTargetIds(action.actions, tab.targetId);
            if (targetIdError) {
              return jsonActError(res, 403, ACT_ERROR_CODES.targetIdMismatch, targetIdError);
            }
          }
          const result = await pw.executeActViaPlaywright({
            cdpUrl,
            action,
            targetId: tab.targetId,
            evaluateEnabled,
            ssrfPolicy,
            signal: req.signal,
          });
          switch (action.kind) {
            case "batch":
              return await jsonOk(
                { results: result.results ?? [] },
                { resolveCurrentTarget: true },
              );
            case "evaluate":
              return await jsonOk({ result: result.result }, { resolveCurrentTarget: true });
            case "click":
            case "clickCoords":
              return await jsonOk(undefined, { resolveCurrentTarget: true });
            case "resize":
              return await jsonOk();
            default:
              return await jsonOk(undefined, { resolveCurrentTarget: true });
          }
        },
      });
    }),
  );

  registerBrowserAgentActHookRoutes(app, ctx);
  registerBrowserAgentActDownloadRoutes(app, ctx);

  app.post(
    "/response/body",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      const url = toStringOrEmpty(body.url);
      const timeoutMs = toNumber(body.timeoutMs);
      const maxChars = toNumber(body.maxChars);
      if (!url) {
        return jsonError(res, 400, "url is required");
      }

      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId,
        run: async ({ profileCtx, cdpUrl, tab, resolveTabUrl }) => {
          if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
            return jsonError(res, 501, EXISTING_SESSION_LIMITS.responseBody);
          }
          const pw = await requirePwAi(res, "response body");
          if (!pw) {
            return;
          }
          const result = await pw.responseBodyViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            url,
            timeoutMs: timeoutMs ?? undefined,
            maxChars: maxChars ?? undefined,
          });
          const currentUrl = await resolveTabUrl(tab.url);
          res.json({
            ok: true,
            targetId: tab.targetId,
            ...(currentUrl ? { url: currentUrl } : {}),
            response: result,
          });
        },
      });
    }),
  );

  app.post(
    "/highlight",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      const ref = toStringOrEmpty(body.ref);
      if (!ref) {
        return jsonError(res, 400, "ref is required");
      }

      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId,
        run: async ({ profileCtx, cdpUrl, tab, resolveTabUrl }) => {
          const jsonOk = async () => {
            const currentUrl = await resolveTabUrl(tab.url);
            return res.json({
              ok: true,
              targetId: tab.targetId,
              ...(currentUrl ? { url: currentUrl } : {}),
            });
          };
          if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
            await evaluateChromeMcpScript({
              profileName: profileCtx.profile.name,
              profile: profileCtx.profile,
              targetId: tab.targetId,
              args: [ref],
              fn: `(el) => {
              if (!(el instanceof Element)) {
                return false;
              }
              el.scrollIntoView({ block: "center", inline: "center" });
              const previousOutline = el.style.outline;
              const previousOffset = el.style.outlineOffset;
              el.style.outline = "3px solid #FF4500";
              el.style.outlineOffset = "2px";
              setTimeout(() => {
                el.style.outline = previousOutline;
                el.style.outlineOffset = previousOffset;
              }, 2000);
              return true;
            }`,
            });
            return await jsonOk();
          }
          const pw = await requirePwAi(res, "highlight");
          if (!pw) {
            return;
          }
          await pw.highlightViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            ref,
          });
          await jsonOk();
        },
      });
    }),
  );
}
