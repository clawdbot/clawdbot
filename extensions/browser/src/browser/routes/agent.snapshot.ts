import path from "node:path";
import { ensureMediaDir, saveMediaBuffer } from "../../media/store.js";
import { resolveBrowserNavigationProxyMode } from "../browser-proxy-mode.js";
import { captureScreenshot, snapshotAria, snapshotRoleViaCdp } from "../cdp.js";
import {
  evaluateChromeMcpScript,
  navigateChromeMcpPage,
  takeChromeMcpScreenshot,
  takeChromeMcpSnapshot,
  type ChromeMcpProfileOptions,
} from "../chrome-mcp.js";
import {
  buildAiSnapshotFromChromeMcpSnapshot,
  flattenChromeMcpSnapshotToAriaNodes,
} from "../chrome-mcp.snapshot.js";
import { DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS } from "../constants.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed,
} from "../navigation-guard.js";
import { withBrowserNavigationPolicy } from "../navigation-guard.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import {
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
  normalizeBrowserScreenshot,
} from "../screenshot.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import {
  getPwAiModule,
  handleRouteError,
  readBody,
  requirePwAi,
  resolveProfileContext,
  withPlaywrightRouteContext,
  withRouteTabContext,
} from "./agent.shared.js";
import { resolveTargetIdAfterNavigate } from "./agent.snapshot-target.js";
import {
  resolveSnapshotPlan,
  shouldUsePlaywrightForAriaSnapshot,
  shouldUsePlaywrightForScreenshot,
} from "./agent.snapshot.plan.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import type { BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import { asyncBrowserRoute, jsonError, toBoolean, toNumber, toStringOrEmpty } from "./utils.js";

const CHROME_MCP_OVERLAY_ATTR = "data-openclaw-mcp-overlay";

function browserNavigationPolicyForProfile(ctx: BrowserRouteContext, profileCtx: ProfileContext) {
  return withBrowserNavigationPolicy(ctx.state().resolved.ssrfPolicy, {
    browserProxyMode: resolveBrowserNavigationProxyMode({
      resolved: ctx.state().resolved,
      profile: profileCtx.profile,
    }),
  });
}

async function collectChromeMcpSnapshotUrls(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
}): Promise<Array<{ text: string; url: string }>> {
  const result = await evaluateChromeMcpScript({
    profileName: params.profileName,
    profile: params.profile,
    userDataDir: params.userDataDir,
    targetId: params.targetId,
    fn: `() => {
      const seen = new Set();
      const out = [];
      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        const href = anchor.href || "";
        if (!href || seen.has(href)) continue;
        const text = (anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label") || "")
          .replace(/\\s+/g, " ")
          .trim()
          .slice(0, 120) || href;
        seen.add(href);
        out.push({ text, url: href });
        if (out.length >= 100) break;
      }
      return out;
    }`,
  }).catch(() => []);
  return Array.isArray(result)
    ? result.filter(
        (entry): entry is { text: string; url: string } =>
          entry &&
          typeof entry === "object" &&
          typeof (entry as { text?: unknown }).text === "string" &&
          typeof (entry as { url?: unknown }).url === "string",
      )
    : [];
}

function appendSnapshotUrls(snapshot: string, urls: Array<{ text: string; url: string }>): string {
  if (urls.length === 0) {
    return snapshot;
  }
  const lines = urls.map((entry, index) => `${index + 1}. ${entry.text} -> ${entry.url}`);
  return `${snapshot}\n\nLinks:\n${lines.join("\n")}`;
}

async function clearChromeMcpOverlay(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
}): Promise<void> {
  await evaluateChromeMcpScript({
    profileName: params.profileName,
    profile: params.profile,
    userDataDir: params.userDataDir,
    targetId: params.targetId,
    fn: `() => {
      document.querySelectorAll("[${CHROME_MCP_OVERLAY_ATTR}]").forEach((node) => node.remove());
      return true;
    }`,
  }).catch(() => {});
}

async function renderChromeMcpLabels(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  refs: string[];
}): Promise<{ labels: number; skipped: number }> {
  const refList = JSON.stringify(params.refs);
  const result = await evaluateChromeMcpScript({
    profileName: params.profileName,
    profile: params.profile,
    userDataDir: params.userDataDir,
    targetId: params.targetId,
    args: params.refs,
    fn: `(...elements) => {
      const refs = ${refList};
      document.querySelectorAll("[${CHROME_MCP_OVERLAY_ATTR}]").forEach((node) => node.remove());
      const root = document.createElement("div");
      root.setAttribute("${CHROME_MCP_OVERLAY_ATTR}", "labels");
      root.style.position = "fixed";
      root.style.inset = "0";
      root.style.pointerEvents = "none";
      root.style.zIndex = "2147483647";
      let labels = 0;
      let skipped = 0;
      elements.forEach((el, index) => {
        if (!(el instanceof Element)) {
          skipped += 1;
          return;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 && rect.height <= 0) {
          skipped += 1;
          return;
        }
        labels += 1;
        const badge = document.createElement("div");
        badge.setAttribute("${CHROME_MCP_OVERLAY_ATTR}", "label");
        badge.textContent = refs[index] || String(labels);
        badge.style.position = "fixed";
        badge.style.left = \`\${Math.max(0, rect.left)}px\`;
        badge.style.top = \`\${Math.max(0, rect.top)}px\`;
        badge.style.transform = "translateY(-100%)";
        badge.style.padding = "2px 6px";
        badge.style.borderRadius = "999px";
        badge.style.background = "#FF4500";
        badge.style.color = "#fff";
        badge.style.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
        badge.style.boxShadow = "0 2px 6px rgba(0,0,0,0.35)";
        badge.style.whiteSpace = "nowrap";
        root.appendChild(badge);
      });
      document.documentElement.appendChild(root);
      return { labels, skipped };
    }`,
  });
  const labels =
    result &&
    typeof result === "object" &&
    typeof (result as { labels?: unknown }).labels === "number"
      ? (result as { labels: number }).labels
      : 0;
  const skipped =
    result &&
    typeof result === "object" &&
    typeof (result as { skipped?: unknown }).skipped === "number"
      ? (result as { skipped: number }).skipped
      : 0;
  return { labels, skipped };
}

async function saveNormalizedScreenshotResponse(params: {
  res: BrowserResponse;
  buffer: Buffer;
  type: "png" | "jpeg";
  targetId: string;
  url: string;
  labels?: boolean;
  labelsCount?: number;
  labelsSkipped?: number;
}) {
  const normalized = await normalizeBrowserScreenshot(params.buffer, {
    maxSide: DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
    maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
  });
  await saveBrowserMediaResponse({
    res: params.res,
    buffer: normalized.buffer,
    contentType: normalized.contentType ?? `image/${params.type}`,
    maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
    targetId: params.targetId,
    url: params.url,
    labels: params.labels,
    labelsCount: params.labelsCount,
    labelsSkipped: params.labelsSkipped,
  });
}

async function saveBrowserMediaResponse(params: {
  res: BrowserResponse;
  buffer: Buffer;
  contentType: string;
  maxBytes: number;
  targetId: string;
  url: string;
  labels?: boolean;
  labelsCount?: number;
  labelsSkipped?: number;
}) {
  await ensureMediaDir();
  const saved = await saveMediaBuffer(
    params.buffer,
    params.contentType,
    "browser",
    params.maxBytes,
  );
  params.res.json({
    ok: true,
    path: path.resolve(saved.path),
    targetId: params.targetId,
    url: params.url,
    ...(params.labels ? { labels: true } : {}),
    ...(typeof params.labelsCount === "number" ? { labelsCount: params.labelsCount } : {}),
    ...(typeof params.labelsSkipped === "number" ? { labelsSkipped: params.labelsSkipped } : {}),
  });
}

export function registerBrowserAgentSnapshotRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post(
    "/navigate",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const url = toStringOrEmpty(body.url);
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      if (!url) {
        return jsonError(res, 400, "url is required");
      }
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId,
        run: async ({ profileCtx, tab, cdpUrl }) => {
          if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
            const ssrfPolicyOpts = browserNavigationPolicyForProfile(ctx, profileCtx);
            await assertBrowserNavigationAllowed({ url, ...ssrfPolicyOpts });
            const result = await navigateChromeMcpPage({
              profileName: profileCtx.profile.name,
              profile: profileCtx.profile,
              targetId: tab.targetId,
              url,
            });
            await assertBrowserNavigationResultAllowed({ url: result.url, ...ssrfPolicyOpts });
            return res.json({ ok: true, targetId: tab.targetId, ...result });
          }
          const pw = await requirePwAi(res, "navigate");
          if (!pw) {
            return;
          }
          const result = await pw.navigateViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            url,
            ...browserNavigationPolicyForProfile(ctx, profileCtx),
          });
          const currentTargetId = await resolveTargetIdAfterNavigate({
            oldTargetId: tab.targetId,
            navigatedUrl: result.url,
            listTabs: () => profileCtx.listTabs(),
          });
          res.json({ ok: true, targetId: currentTargetId, ...result });
        },
      });
    }),
  );

  app.post(
    "/pdf",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      const profileCtx = resolveProfileContext(req, res, ctx);
      if (!profileCtx) {
        return;
      }
      if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
        return jsonError(res, 501, EXISTING_SESSION_LIMITS.snapshot.pdfUnsupported);
      }
      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "pdf",
        run: async ({ cdpUrl, tab, pw }) => {
          const pdf = await pw.pdfViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
          });
          await saveBrowserMediaResponse({
            res,
            buffer: pdf.buffer,
            contentType: "application/pdf",
            maxBytes: pdf.buffer.byteLength,
            targetId: tab.targetId,
            url: tab.url,
          });
        },
      });
    }),
  );

  app.post(
    "/screenshot",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      const fullPage = toBoolean(body.fullPage) ?? false;
      const ref = toStringOrEmpty(body.ref) || undefined;
      const element = toStringOrEmpty(body.element) || undefined;
      const labels = toBoolean(body.labels) ?? false;
      const type = body.type === "jpeg" ? "jpeg" : "png";
      const timeoutMsRaw = toNumber(body.timeoutMs);
      const timeoutMs =
        timeoutMsRaw !== undefined
          ? Math.max(1, Math.floor(timeoutMsRaw))
          : DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS;

      if (fullPage && (ref || element)) {
        return jsonError(res, 400, "fullPage is not supported for element screenshots");
      }

      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId,
        run: async ({ profileCtx, tab, cdpUrl }) => {
          if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
            const ssrfPolicyOpts = browserNavigationPolicyForProfile(ctx, profileCtx);
            if (element) {
              return jsonError(res, 400, EXISTING_SESSION_LIMITS.snapshot.screenshotElement);
            }
            if (ssrfPolicyOpts.ssrfPolicy) {
              await assertBrowserNavigationResultAllowed({
                url: tab.url,
                ...ssrfPolicyOpts,
              });
            }
            if (labels) {
              const snapshot = await takeChromeMcpSnapshot({
                profileName: profileCtx.profile.name,
                profile: profileCtx.profile,
                targetId: tab.targetId,
              });
              const built = buildAiSnapshotFromChromeMcpSnapshot({ root: snapshot });
              const labelResult = await renderChromeMcpLabels({
                profileName: profileCtx.profile.name,
                profile: profileCtx.profile,
                targetId: tab.targetId,
                refs: Object.keys(built.refs),
              });
              try {
                const buffer = await takeChromeMcpScreenshot({
                  profileName: profileCtx.profile.name,
                  profile: profileCtx.profile,
                  targetId: tab.targetId,
                  fullPage,
                  format: type,
                  timeoutMs,
                });
                await saveNormalizedScreenshotResponse({
                  res,
                  buffer,
                  type,
                  targetId: tab.targetId,
                  url: tab.url,
                  labels: true,
                  labelsCount: labelResult.labels,
                  labelsSkipped: labelResult.skipped,
                });
              } finally {
                await clearChromeMcpOverlay({
                  profileName: profileCtx.profile.name,
                  profile: profileCtx.profile,
                  targetId: tab.targetId,
                });
              }
              return;
            }
            const buffer = await takeChromeMcpScreenshot({
              profileName: profileCtx.profile.name,
              profile: profileCtx.profile,
              targetId: tab.targetId,
              uid: ref,
              fullPage,
              format: type,
              timeoutMs,
            });
            await saveNormalizedScreenshotResponse({
              res,
              buffer,
              type,
              targetId: tab.targetId,
              url: tab.url,
            });
            return;
          }

          let buffer: Buffer;
          const shouldUsePlaywright =
            labels ||
            shouldUsePlaywrightForScreenshot({
              profile: profileCtx.profile,
              wsUrl: tab.wsUrl,
              ref,
              element,
            });
          if (shouldUsePlaywright) {
            const pw = await requirePwAi(res, "screenshot");
            if (!pw) {
              return;
            }
            if (labels) {
              const snap = await pw.snapshotRoleViaPlaywright({
                cdpUrl,
                targetId: tab.targetId,
                ssrfPolicy: ctx.state().resolved.ssrfPolicy,
              });
              const labeled = await pw.screenshotWithLabelsViaPlaywright({
                cdpUrl,
                targetId: tab.targetId,
                refs: snap.refs,
                type,
                timeoutMs,
              });
              await saveNormalizedScreenshotResponse({
                res,
                buffer: labeled.buffer,
                type,
                targetId: tab.targetId,
                url: tab.url,
                labels: true,
                labelsCount: labeled.labels,
                labelsSkipped: labeled.skipped,
              });
              return;
            }
            const snap = await pw.takeScreenshotViaPlaywright({
              cdpUrl,
              targetId: tab.targetId,
              ref,
              element,
              fullPage,
              type,
              timeoutMs,
            });
            buffer = snap.buffer;
          } else {
            buffer = await captureScreenshot({
              wsUrl: tab.wsUrl ?? "",
              fullPage,
              format: type,
              quality: type === "jpeg" ? 85 : undefined,
              timeoutMs,
            });
          }

          await saveNormalizedScreenshotResponse({
            res,
            buffer,
            type,
            targetId: tab.targetId,
            url: tab.url,
          });
        },
      });
    }),
  );

  app.get(
    "/snapshot",
    asyncBrowserRoute(async (req, res) => {
      const profileCtx = resolveProfileContext(req, res, ctx);
      if (!profileCtx) {
        return;
      }
      const targetId = typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
      const pwModule = await getPwAiModule();
      const hasPlaywright = Boolean(pwModule);
      const plan = resolveSnapshotPlan({
        profile: profileCtx.profile,
        query: req.query,
        hasPlaywright,
      });

      try {
        const tab = await profileCtx.ensureTabAvailable(targetId || undefined);
        if ((plan.labels || plan.mode === "efficient") && plan.format === "aria") {
          return jsonError(res, 400, "labels/mode=efficient require format=ai");
        }
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          const ssrfPolicyOpts = browserNavigationPolicyForProfile(ctx, profileCtx);
          if (plan.selectorValue || plan.frameSelectorValue) {
            return jsonError(res, 400, EXISTING_SESSION_LIMITS.snapshot.snapshotSelector);
          }
          if (ssrfPolicyOpts.ssrfPolicy) {
            await assertBrowserNavigationResultAllowed({
              url: tab.url,
              ...ssrfPolicyOpts,
            });
          }
          const snapshot = await takeChromeMcpSnapshot({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            targetId: tab.targetId,
          });
          if (plan.format === "aria") {
            return res.json({
              ok: true,
              format: "aria",
              targetId: tab.targetId,
              url: tab.url,
              nodes: flattenChromeMcpSnapshotToAriaNodes(snapshot, plan.limit),
            });
          }
          const built = buildAiSnapshotFromChromeMcpSnapshot({
            root: snapshot,
            options: {
              interactive: plan.interactive ?? undefined,
              compact: plan.compact ?? undefined,
              maxDepth: plan.depth ?? undefined,
            },
            maxChars: plan.resolvedMaxChars,
          });
          const builtWithUrls = plan.urls
            ? {
                ...built,
                snapshot: appendSnapshotUrls(
                  built.snapshot,
                  await collectChromeMcpSnapshotUrls({
                    profileName: profileCtx.profile.name,
                    profile: profileCtx.profile,
                    targetId: tab.targetId,
                  }),
                ),
              }
            : built;
          if (plan.labels) {
            const refs = Object.keys(builtWithUrls.refs);
            const labelResult = await renderChromeMcpLabels({
              profileName: profileCtx.profile.name,
              profile: profileCtx.profile,
              targetId: tab.targetId,
              refs,
            });
            try {
              const labeled = await takeChromeMcpScreenshot({
                profileName: profileCtx.profile.name,
                profile: profileCtx.profile,
                targetId: tab.targetId,
                format: "png",
              });
              const normalized = await normalizeBrowserScreenshot(labeled, {
                maxSide: DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
                maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
              });
              await ensureMediaDir();
              const saved = await saveMediaBuffer(
                normalized.buffer,
                normalized.contentType ?? "image/png",
                "browser",
                DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
              );
              return res.json({
                ok: true,
                format: "ai",
                targetId: tab.targetId,
                url: tab.url,
                labels: true,
                labelsCount: labelResult.labels,
                labelsSkipped: labelResult.skipped,
                imagePath: path.resolve(saved.path),
                imageType: normalized.contentType?.includes("jpeg") ? "jpeg" : "png",
                ...builtWithUrls,
              });
            } finally {
              await clearChromeMcpOverlay({
                profileName: profileCtx.profile.name,
                profile: profileCtx.profile,
                targetId: tab.targetId,
              });
            }
          }
          return res.json({
            ok: true,
            format: "ai",
            targetId: tab.targetId,
            url: tab.url,
            ...builtWithUrls,
          });
        }
        if (plan.format === "ai") {
          const roleSnapshotArgs = {
            cdpUrl: profileCtx.profile.cdpUrl,
            targetId: tab.targetId,
            selector: plan.selectorValue,
            frameSelector: plan.frameSelectorValue,
            refsMode: plan.refsMode,
            ssrfPolicy: ctx.state().resolved.ssrfPolicy,
            urls: plan.urls,
            options: {
              interactive: plan.interactive ?? undefined,
              compact: plan.compact ?? undefined,
              maxDepth: plan.depth ?? undefined,
            },
          };

          const cdpRoleSnapshot = async () => {
            if (!tab.wsUrl) {
              return null;
            }
            if (plan.selectorValue || plan.frameSelectorValue) {
              return null;
            }
            return await snapshotRoleViaCdp({
              wsUrl: tab.wsUrl,
              urls: plan.urls,
              options: {
                interactive: plan.interactive ?? undefined,
                compact: plan.compact ?? undefined,
                maxDepth: plan.depth ?? undefined,
              },
            });
          };

          const pw = await getPwAiModule();
          const snap = plan.wantsRoleSnapshot
            ? pw
              ? await pw.snapshotRoleViaPlaywright(roleSnapshotArgs).catch(async (err) => {
                  const fallback = await cdpRoleSnapshot();
                  if (fallback) {
                    return fallback;
                  }
                  throw err;
                })
              : await cdpRoleSnapshot()
            : pw
              ? await pw.snapshotAiViaPlaywright({
                  cdpUrl: profileCtx.profile.cdpUrl,
                  targetId: tab.targetId,
                  ssrfPolicy: ctx.state().resolved.ssrfPolicy,
                  urls: plan.urls,
                  ...(typeof plan.resolvedMaxChars === "number"
                    ? { maxChars: plan.resolvedMaxChars }
                    : {}),
                })
              : await cdpRoleSnapshot();
          if (!snap) {
            await requirePwAi(res, "ai snapshot");
            return;
          }
          if (plan.labels) {
            if (!pw) {
              return jsonError(res, 501, "Snapshot labels require Playwright.");
            }
            const labeled = await pw.screenshotWithLabelsViaPlaywright({
              cdpUrl: profileCtx.profile.cdpUrl,
              targetId: tab.targetId,
              refs: "refs" in snap ? snap.refs : {},
              type: "png",
            });
            const normalized = await normalizeBrowserScreenshot(labeled.buffer, {
              maxSide: DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
              maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
            });
            await ensureMediaDir();
            const saved = await saveMediaBuffer(
              normalized.buffer,
              normalized.contentType ?? "image/png",
              "browser",
              DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
            );
            const imageType = normalized.contentType?.includes("jpeg") ? "jpeg" : "png";
            return res.json({
              ok: true,
              format: plan.format,
              targetId: tab.targetId,
              url: tab.url,
              labels: true,
              labelsCount: labeled.labels,
              labelsSkipped: labeled.skipped,
              imagePath: path.resolve(saved.path),
              imageType,
              ...snap,
            });
          }

          return res.json({
            ok: true,
            format: plan.format,
            targetId: tab.targetId,
            url: tab.url,
            ...snap,
          });
        }

        const usePlaywrightAriaSnapshot = shouldUsePlaywrightForAriaSnapshot({
          profile: profileCtx.profile,
          wsUrl: tab.wsUrl,
        });
        const snap = usePlaywrightAriaSnapshot
          ? (() => {
              // Extension relay doesn't expose per-page WS URLs; run AX snapshot via Playwright CDP session.
              // Also covers cases where wsUrl is missing/unusable.
              return requirePwAi(res, "aria snapshot").then(async (pw) => {
                if (!pw) {
                  return null;
                }
                return await pw.snapshotAriaViaPlaywright({
                  cdpUrl: profileCtx.profile.cdpUrl,
                  targetId: tab.targetId,
                  limit: plan.limit,
                  ssrfPolicy: ctx.state().resolved.ssrfPolicy,
                });
              });
            })()
          : snapshotAria({ wsUrl: tab.wsUrl ?? "", limit: plan.limit });

        const resolved = await Promise.resolve(snap);
        if (!resolved) {
          return;
        }
        if (!usePlaywrightAriaSnapshot) {
          await pwModule?.storeAriaSnapshotRefsViaPlaywright?.({
            cdpUrl: profileCtx.profile.cdpUrl,
            targetId: tab.targetId,
            nodes: resolved.nodes,
          });
        }
        return res.json({
          ok: true,
          format: plan.format,
          targetId: tab.targetId,
          url: tab.url,
          ...resolved,
        });
      } catch (err) {
        handleRouteError(ctx, res, err);
      }
    }),
  );
}
