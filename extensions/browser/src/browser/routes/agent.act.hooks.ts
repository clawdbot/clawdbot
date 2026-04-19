import { evaluateChromeMcpScript, uploadChromeMcpFile } from "../chrome-mcp.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { BrowserRouteContext } from "../server-context.js";
import {
  readBody,
  requirePwAi,
  resolveTargetIdFromBody,
  withRouteTabContext,
} from "./agent.shared.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import { DEFAULT_UPLOAD_DIR, resolveExistingPathsWithinRoot } from "./path-output.js";
import type { BrowserRouteRegistrar } from "./types.js";
import {
  asyncBrowserRoute,
  jsonError,
  toBoolean,
  toNumber,
  toStringArray,
  toStringOrEmpty,
} from "./utils.js";

export function registerBrowserAgentActHookRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post(
    "/hooks/file-chooser",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      const ref = toStringOrEmpty(body.ref) || undefined;
      const inputRef = toStringOrEmpty(body.inputRef) || undefined;
      const element = toStringOrEmpty(body.element) || undefined;
      const paths = toStringArray(body.paths) ?? [];
      const timeoutMs = toNumber(body.timeoutMs);
      if (!paths.length) {
        return jsonError(res, 400, "paths are required");
      }

      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId,
        run: async ({ profileCtx, cdpUrl, tab }) => {
          const uploadPathsResult = await resolveExistingPathsWithinRoot({
            rootDir: DEFAULT_UPLOAD_DIR,
            requestedPaths: paths,
            scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`,
          });
          if (!uploadPathsResult.ok) {
            res.status(400).json({ error: uploadPathsResult.error });
            return;
          }
          const resolvedPaths = uploadPathsResult.paths;

          if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
            if (element) {
              return jsonError(res, 501, EXISTING_SESSION_LIMITS.hooks.uploadElement);
            }
            if (resolvedPaths.length !== 1) {
              return jsonError(res, 501, EXISTING_SESSION_LIMITS.hooks.uploadSingleFile);
            }
            const uid = inputRef || ref;
            if (!uid) {
              return jsonError(res, 501, EXISTING_SESSION_LIMITS.hooks.uploadRefRequired);
            }
            await uploadChromeMcpFile({
              profileName: profileCtx.profile.name,
              userDataDir: profileCtx.profile.userDataDir,
              targetId: tab.targetId,
              uid,
              filePath: resolvedPaths[0] ?? "",
            });
            return res.json({ ok: true });
          }

          const pw = await requirePwAi(res, "file chooser hook");
          if (!pw) {
            return;
          }

          if (inputRef || element) {
            if (ref) {
              return jsonError(res, 400, "ref cannot be combined with inputRef/element");
            }
            await pw.setInputFilesViaPlaywright({
              cdpUrl,
              targetId: tab.targetId,
              inputRef,
              element,
              paths: resolvedPaths,
            });
          } else {
            await pw.armFileUploadViaPlaywright({
              cdpUrl,
              targetId: tab.targetId,
              paths: resolvedPaths,
              timeoutMs: timeoutMs ?? undefined,
            });
            if (ref) {
              await pw.clickViaPlaywright({
                cdpUrl,
                targetId: tab.targetId,
                ssrfPolicy: ctx.state().resolved.ssrfPolicy,
                ref,
              });
            }
          }
          res.json({ ok: true });
        },
      });
    }),
  );

  app.post(
    "/hooks/dialog",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      const accept = toBoolean(body.accept);
      const promptText = toStringOrEmpty(body.promptText) || undefined;
      const timeoutMs = toNumber(body.timeoutMs);
      if (accept === undefined) {
        return jsonError(res, 400, "accept is required");
      }

      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId,
        run: async ({ profileCtx, cdpUrl, tab }) => {
          if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
            if (timeoutMs) {
              return jsonError(res, 501, EXISTING_SESSION_LIMITS.hooks.dialogTimeout);
            }
            await evaluateChromeMcpScript({
              profileName: profileCtx.profile.name,
              userDataDir: profileCtx.profile.userDataDir,
              targetId: tab.targetId,
              fn: `() => {
              const state = (window.__openclawDialogHook ??= {});
              if (!state.originals) {
                state.originals = {
                  alert: window.alert.bind(window),
                  confirm: window.confirm.bind(window),
                  prompt: window.prompt.bind(window),
                };
              }
              const originals = state.originals;
              const restore = () => {
                window.alert = originals.alert;
                window.confirm = originals.confirm;
                window.prompt = originals.prompt;
                delete window.__openclawDialogHook;
              };
              window.alert = (...args) => {
                try {
                  return undefined;
                } finally {
                  restore();
                }
              };
              window.confirm = (...args) => {
                try {
                  return ${accept ? "true" : "false"};
                } finally {
                  restore();
                }
              };
              window.prompt = (...args) => {
                try {
                  return ${accept ? JSON.stringify(promptText ?? "") : "null"};
                } finally {
                  restore();
                }
              };
              return true;
            }`,
            });
            return res.json({ ok: true });
          }
          const pw = await requirePwAi(res, "dialog hook");
          if (!pw) {
            return;
          }
          await pw.armDialogViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            accept,
            promptText,
            timeoutMs: timeoutMs ?? undefined,
          });
          res.json({ ok: true });
        },
      });
    }),
  );
}
