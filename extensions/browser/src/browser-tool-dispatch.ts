/** Browser tab action dispatch. Execution routing is prepared once by the tool owner. */
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserProxyRequest } from "./browser-node-proxy.js";
import {
  type createBrowserToolSessionTabs,
  stripBrowserOpenInternalMetadata,
} from "./browser-tool-session-tabs.js";
import {
  executeActAction,
  executeConsoleAction,
  executeDownloadAction,
  executeEmulateAction,
  executeRequestsAction,
  executeErrorsAction,
  executeTextAction,
  executeTabsAction,
  formatBrowserExternalToolResult,
} from "./browser-tool.actions.js";
import {
  type BrowserToolCapabilities,
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserCloseTab,
  browserFocusTab,
  browserNavigate,
  browserOpenTab,
  browserPdfSave,
  jsonResult,
  normalizeOptionalString,
  readPositiveIntegerParam,
  readStringParam,
  readStringValue,
  resolveExistingUploadPaths,
} from "./browser-tool.runtime.js";
import {
  executeScreenshotAction,
  type BrowserScreenshotOptions,
} from "./browser-tool.screenshot.js";
import { appendNavigatedPageState, executeSnapshotAction } from "./browser-tool.snapshot.js";
import {
  BROWSER_ACTION_TRANSPORT_SLACK_MS,
  resolveBrowserNavigationTimeoutMs,
} from "./browser/act-policy.js";
import { parseBrowserNavigationUrl } from "./browser/navigation-guard.js";

function readOptionalTargetAndTimeout(params: Record<string, unknown>) {
  const targetId = normalizeOptionalString(params.targetId);
  const timeoutMs = readPositiveIntegerParam(params, "timeoutMs", {
    message: "timeoutMs must be a positive integer.",
  });
  return { targetId, timeoutMs };
}

function readTargetUrlParam(params: Record<string, unknown>) {
  const targetUrl =
    readStringParam(params, "targetUrl") ??
    readStringParam(params, "url", { required: true, label: "targetUrl" });
  parseBrowserNavigationUrl(targetUrl);
  return targetUrl;
}

/** Run tab actions against the prepared host, node, or sandbox route. */
export async function executeBrowserTabAction(context: {
  action: string;
  actRequest?: Parameters<typeof browserAct>[1];
  params: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
  nodeRoute?: Parameters<typeof createBrowserToolSessionTabs>[0]["nodeRoute"];
  sessionTabs: ReturnType<typeof createBrowserToolSessionTabs>;
  capabilities: BrowserToolCapabilities;
  isUserBrowserProfile: boolean;
  boundTargetId?: string;
  toolTimeoutMs?: number;
  requestedTimeoutMs?: number;
  signal?: AbortSignal;
  opts?: BrowserScreenshotOptions;
  onTabActivity: (targetId: string | undefined, openedProfile?: string) => void;
}): Promise<AgentToolResult<unknown>> {
  const {
    action,
    params,
    baseUrl,
    profile,
    proxyRequest,
    nodeRoute,
    sessionTabs,
    capabilities,
    isUserBrowserProfile,
    toolTimeoutMs,
    requestedTimeoutMs,
    signal,
    opts,
  } = context;
  const touchTab = (targetId: string | undefined) => {
    sessionTabs.touch(targetId);
    context.onTabActivity(targetId);
  };
  const executeTrackedTabRequest = async (
    path: string,
    body: Record<string, unknown>,
    runLocal: () => Promise<unknown>,
  ) => {
    const result = proxyRequest
      ? await proxyRequest({ method: "POST", path, profile, body })
      : await runLocal();
    touchTab(readStringValue(asNullableRecord(result)?.targetId) ?? readStringValue(body.targetId));
    return jsonResult(result);
  };
  switch (action) {
    case "tabs":
      return await executeTabsAction({
        baseUrl,
        profile,
        timeoutMs: toolTimeoutMs,
        proxyRequest,
        targetId: context.boundTargetId,
        signal,
      });
    case "open": {
      const targetUrl = readTargetUrlParam(params);
      const label = normalizeOptionalString(params.label);
      const opened = proxyRequest
        ? await proxyRequest({
            method: "POST",
            path: "/tabs/open",
            profile,
            body: { url: targetUrl, ...(label ? { label } : {}) },
            timeoutMs: toolTimeoutMs,
          })
        : await browserOpenTab(baseUrl, targetUrl, {
            profile,
            label,
            timeoutMs: toolTimeoutMs,
            signal,
          });
      const closeOpenedTab = async (targetId: string, openedProfile?: string) => {
        if (nodeRoute && !proxyRequest?.isHostFallbackActive()) {
          await nodeRoute.closeTarget({ targetId, profile: openedProfile });
          return;
        }
        await browserCloseTab(baseUrl, targetId, {
          profile: openedProfile,
          timeoutMs: toolTimeoutMs,
        });
      };
      await sessionTabs.trackOpened(opened, closeOpenedTab);
      context.onTabActivity(
        readStringValue(asNullableRecord(opened)?.targetId),
        readStringValue(asNullableRecord(opened)?.resolvedProfile),
      );
      return formatBrowserExternalToolResult({
        kind: "tabs",
        payload: stripBrowserOpenInternalMetadata(opened),
      });
    }
    case "focus": {
      const targetId = readStringParam(params, "targetId", {
        required: true,
      });
      const result = proxyRequest
        ? await proxyRequest({
            method: "POST",
            path: "/tabs/focus",
            profile,
            body: { targetId },
            timeoutMs: toolTimeoutMs,
          })
        : await browserFocusTab(baseUrl, targetId, {
            profile,
            timeoutMs: toolTimeoutMs,
            signal,
          });
      touchTab(readStringValue(asNullableRecord(result)?.targetId) ?? targetId);
      return jsonResult(result);
    }
    case "close": {
      const targetId = readStringParam(params, "targetId");
      if (proxyRequest) {
        const result = targetId
          ? await proxyRequest({
              method: "DELETE",
              path: `/tabs/${encodeURIComponent(targetId)}`,
              profile,
              timeoutMs: toolTimeoutMs,
            })
          : await proxyRequest({
              method: "POST",
              path: "/act",
              profile,
              body: { kind: "close" },
              timeoutMs: toolTimeoutMs,
            });
        sessionTabs.untrack(readStringValue(asNullableRecord(result)?.targetId) ?? targetId);
        return jsonResult(result);
      }
      const result = targetId
        ? await browserCloseTab(baseUrl, targetId, {
            profile,
            timeoutMs: toolTimeoutMs,
            signal,
          })
        : await browserAct(
            baseUrl,
            { kind: "close" },
            {
              profile,
              timeoutMs: toolTimeoutMs,
              signal,
            },
          );
      sessionTabs.untrack(readStringValue(result.targetId) ?? targetId);
      return jsonResult(result);
    }
    case "snapshot":
      return await executeSnapshotAction({
        input: params,
        baseUrl,
        profile,
        proxyRequest,
        signal,
        onTabActivity: touchTab,
      });
    case "screenshot":
      return await executeScreenshotAction({
        input: params,
        baseUrl,
        profile,
        requestedTimeoutMs,
        proxyRequest,
        signal,
        onTabActivity: touchTab,
        opts,
      });
    case "navigate": {
      const targetUrl = readTargetUrlParam(params);
      const targetId = readStringParam(params, "targetId");
      const timeoutMs = resolveBrowserNavigationTimeoutMs(requestedTimeoutMs);
      const result = proxyRequest
        ? await proxyRequest({
            method: "POST",
            path: "/navigate",
            profile,
            body: {
              url: targetUrl,
              targetId,
              timeoutMs,
            },
            timeoutMs: timeoutMs + BROWSER_ACTION_TRANSPORT_SLACK_MS,
          })
        : await browserNavigate(baseUrl, {
            url: targetUrl,
            targetId,
            timeoutMs,
            profile,
            signal,
          });
      const navigatedTargetId = readStringValue(asNullableRecord(result)?.targetId) ?? targetId;
      touchTab(navigatedTargetId);
      const formatted = formatBrowserExternalToolResult({
        kind: asNullableRecord(result)?.download ? "download" : "act",
        payload: result,
      });
      // A navigation that resolved to a download leaves the document
      // unchanged, so inline page state would describe the wrong thing.
      if (asNullableRecord(result)?.download) {
        return formatted;
      }
      return await appendNavigatedPageState({
        result: formatted,
        targetId: navigatedTargetId,
        baseUrl,
        profile,
        proxyRequest,
        signal,
      });
    }
    case "console": {
      const result = await executeConsoleAction({
        input: params,
        baseUrl,
        profile,
        proxyRequest,
        signal,
      });
      const targetId = readStringParam(params, "targetId");
      const canonicalTargetId = readStringValue(asNullableRecord(result.details)?.targetId);
      touchTab(canonicalTargetId ?? targetId);
      return result;
    }
    case "requests":
    case "errors":
    case "text":
    case "emulate": {
      const execute = {
        requests: executeRequestsAction,
        errors: executeErrorsAction,
        text: executeTextAction,
        emulate: executeEmulateAction,
      }[action];
      const result = await execute({ input: params, baseUrl, profile, proxyRequest, signal });
      touchTab(
        readStringValue(asNullableRecord(result.details)?.targetId) ??
          readStringValue(params.targetId),
      );
      return result;
    }
    case "pdf": {
      const targetId = normalizeOptionalString(params.targetId);
      const result = proxyRequest
        ? ((await proxyRequest({
            method: "POST",
            path: "/pdf",
            profile,
            body: { targetId },
            // SAFETY: The node dispatches the same /pdf route as the typed local client.
          })) as Awaited<ReturnType<typeof browserPdfSave>>)
        : await browserPdfSave(baseUrl, { targetId, profile, signal });
      touchTab(readStringValue(result.targetId) ?? targetId);
      return {
        content: [{ type: "text" as const, text: `FILE:${result.path}` }],
        details: result,
      };
    }
    case "download":
    case "waitfordownload":
      return await executeDownloadAction({
        action,
        input: params,
        baseUrl,
        profile,
        proxyRequest,
        signal,
        onTabActivity: touchTab,
      });
    case "upload": {
      const paths = Array.isArray(params.paths) ? params.paths.map((p) => String(p)) : [];
      if (paths.length === 0) {
        throw new Error("paths required");
      }
      const resolvedResult = await resolveExistingUploadPaths({ requestedPaths: paths });
      if (!resolvedResult.ok) {
        throw new Error(resolvedResult.error);
      }
      const normalizedPaths = resolvedResult.paths;
      const ref = readStringParam(params, "ref");
      const inputRef = readStringParam(params, "inputRef");
      const element = readStringParam(params, "element");
      const { targetId, timeoutMs } = readOptionalTargetAndTimeout(params);
      const request = {
        paths: normalizedPaths,
        ref,
        inputRef,
        element,
        targetId,
        timeoutMs,
      };
      return await executeTrackedTabRequest(
        "/hooks/file-chooser",
        request,
        async () => await browserArmFileChooser(baseUrl, { ...request, profile, signal }),
      );
    }
    case "dialog": {
      const accept = Boolean(params.accept);
      const promptText = readStringValue(params.promptText);
      const dialogId = readStringValue(params.dialogId);
      const { targetId, timeoutMs } = readOptionalTargetAndTimeout(params);
      const request = { accept, promptText, dialogId, targetId, timeoutMs };
      return await executeTrackedTabRequest(
        "/hooks/dialog",
        request,
        async () => await browserArmDialog(baseUrl, { ...request, profile, signal }),
      );
    }
    case "act": {
      const request = context.actRequest;
      if (!request) {
        throw new Error("request required");
      }
      if (!capabilities.actKinds.some((kind) => kind === request.kind)) {
        throw new Error(
          `browser act kind ${JSON.stringify(request.kind)} is unavailable for this run`,
        );
      }
      return await executeActAction({
        request,
        baseUrl,
        profile,
        usesChromeMcp: isUserBrowserProfile,
        proxyRequest,
        signal,
        onTabActivity: touchTab,
        onTabClose: sessionTabs.untrack,
      });
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
