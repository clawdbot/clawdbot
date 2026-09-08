import { BrowserProfileUnavailableError } from "../errors.js";
import { assertBrowserNavigationResultAllowed } from "../navigation-guard.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import { mintBrowserScreencastToken } from "../screencast/tokens.js";
import type { BrowserRouteContext } from "../server-context.js";
import { getProfileLifecycle, isProfileGenerationCurrent } from "../server-context.lifecycle.js";
import {
  browserNavigationPolicyForProfile,
  getPwAiModule,
  readBody,
  resolveTargetIdFromBody,
  withRouteTabContext,
} from "./agent.shared.js";
import type { BrowserRouteRegistrar } from "./types.js";

function clampScreencastOption(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;
}

export function registerBrowserAgentScreencastRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post("/screencast", async (req, res) => {
    const requesterGone = () => {
      if (!req.requester || req.requester.isCurrent()) {
        return false;
      }
      res.status(401).json({
        error: "The Gateway connection that requested the screencast has ended.",
        code: "SCREENCAST_REQUESTER_GONE",
      });
      return true;
    };
    if (requesterGone()) {
      return;
    }
    const body = readBody(req);
    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId: resolveTargetIdFromBody(body),
      enforceCurrentUrlAllowed: true,
      run: async ({ profileCtx, tab, cdpUrl, signal, resolveTabUrl }) => {
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          res.status(501).json({
            error: "Browser screencast is not available for existing-session profiles.",
            code: "SCREENCAST_UNSUPPORTED",
            reason: "existing-session",
          });
          return;
        }
        if (!(await getPwAiModule())) {
          res.status(501).json({
            error: "Browser screencast requires Playwright in this gateway build.",
            code: "SCREENCAST_UNSUPPORTED",
            reason: "playwright",
          });
          return;
        }
        const state = ctx.state();
        const profileName = profileCtx.profile.name;
        const runtime = state.profiles.get(profileName);
        if (!runtime) {
          throw new BrowserProfileUnavailableError("Browser profile is no longer available.");
        }
        const lifecycle = getProfileLifecycle(runtime);
        const generation = lifecycle.generation;
        const configRevision = lifecycle.configRevision;
        const assertCurrent = () => {
          if (
            state.profiles.get(profileName) !== runtime ||
            !isProfileGenerationCurrent({ state, runtime, generation, configRevision })
          ) {
            throw new BrowserProfileUnavailableError("Browser screencast target was superseded.");
          }
        };
        const url = await resolveTabUrl(tab.url);
        signal.throwIfAborted();
        assertCurrent();
        if (requesterGone()) {
          return;
        }
        const { token, expiresAtMs } = mintBrowserScreencastToken({
          profileName,
          targetId: tab.targetId,
          cdpUrl,
          ssrfPolicy: state.resolved.ssrfPolicy,
          maxWidth: clampScreencastOption(body.maxWidth, 320, 2000, 1280),
          maxHeight: clampScreencastOption(body.maxHeight, 320, 2000, 1280),
          quality: clampScreencastOption(body.quality, 30, 90, 70),
          lifecycleGeneration: generation,
          lifecycleSignal: lifecycle.controller.signal,
          requesterSignal: req.requester?.signal,
          isRequesterCurrent: req.requester?.isCurrent,
          assertCurrent,
          checkNavigationAllowed: async (nextUrl) => {
            await assertBrowserNavigationResultAllowed({
              url: nextUrl,
              ...browserNavigationPolicyForProfile(ctx, profileCtx),
            });
          },
        });
        res.json({
          token,
          wsPath: `/browser/screencast?token=${token}`,
          expiresAtMs,
          targetId: tab.targetId,
          url,
        });
      },
    });
  });
}
