import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createBrowserNodeProxyRequest,
  createBrowserNodeSessionTabRoute,
  type BrowserOwnedGatewayRequest,
} from "./browser-node-proxy.js";
import { applyBrowserTabToolBinding, type BrowserTabToolBinding } from "./browser-tool-binding.js";
import {
  createBrowserToolSessionTabs,
  stripBrowserOpenInternalMetadata,
} from "./browser-tool-session-tabs.js";
import {
  executeActAction,
  executeConsoleAction,
  executeDownloadAction,
  executeEmulateAction,
  executeErrorsAction,
  executeRequestsAction,
  executeTabsAction,
  executeTextAction,
  formatBrowserExternalToolResult,
} from "./browser-tool.actions.js";
import { executeBrowserLifecycleAction } from "./browser-tool.lifecycle.js";
import {
  resolveBrowserBaseUrl,
  resolveBrowserToolNodeTarget,
  resolveBrowserToolTimeoutMs,
  type BrowserNodeTarget,
} from "./browser-tool.routing.js";
import type { AnyAgentTool, BrowserToolCapabilities } from "./browser-tool.runtime.js";
import {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserCloseTab,
  browserFocusTab,
  browserNavigate,
  browserOpenTab,
  browserPdfSave,
  getBrowserProfileCapabilities,
  getRuntimeConfig,
  jsonResult,
  normalizeOptionalString,
  readStringParam,
  readStringValue,
  resolveBrowserConfig,
  resolveExistingUploadPaths,
  resolveProfile,
  touchSessionBrowserTab,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./browser-tool.runtime.js";
import { executeScreenshotAction } from "./browser-tool.screenshot.js";
import type { BrowserScreenshotOptions } from "./browser-tool.screenshot.js";
import { appendNavigatedPageState, executeSnapshotAction } from "./browser-tool.snapshot.js";
import { resolveBrowserNavigationTimeoutMs } from "./browser/act-policy.js";
import {
  createBrowserStewardGatewayApprovalClaim,
  getBrowserStewardRuntimeApprovalBinding,
  isBrowserStewardRuntimeApproved,
  matchesBrowserStewardRuntimeApprovalBindingAtExecution,
  resolveBrowserStewardRuntimeApprovedParams,
  resolveBrowserStewardRuntimeApprovalBinding,
  resolveBrowserStewardRuntimePolicyParams,
  type BrowserStewardRuntimeApprovalAuthority,
} from "./browser/browser-steward-approval.js";
import {
  assertBrowserStewardRuntimeAllowed,
  shouldApplyBrowserStewardRuntimeGuard,
  type BrowserStewardRuntimeDecision,
} from "./browser/browser-steward-runtime-guard.js";
import { acquireBrowserNodeSessionLease } from "./browser/browser-steward-tool-params.js";
import {
  readActRequestParam,
  readOptionalTargetAndTimeout,
  readTargetUrlParam,
  readToolTimeoutMs,
} from "./browser/browser-tool-input.js";

export type BrowserToolOptions = BrowserScreenshotOptions & {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  agentSessionKey?: string;
  /** Trusted Gateway owner identity; never read from model arguments. */
  senderIsOwner?: boolean;
  runToolBinding?: unknown;
  /** Browser-owned approval authority; never exposed to model-visible tool arguments. */
  approvalAuthority?: BrowserStewardRuntimeApprovalAuthority;
  /** Browser-owned lifecycle path for retained node-tab cleanup. */
  browserOwnedGatewayRequest?: BrowserOwnedGatewayRequest;
  toolCapabilities?: BrowserToolCapabilities;
};

export function createBrowserToolExecutor(params: {
  opts?: BrowserToolOptions;
  binding?: BrowserTabToolBinding;
  capabilities: BrowserToolCapabilities;
}): NonNullable<AnyAgentTool["execute"]> {
  const { opts, binding, capabilities } = params;
  return async (_toolCallId, args, signal) => {
    const inputParams = asNullableRecord(args) ?? {};
    const publicParams = binding ? applyBrowserTabToolBinding(inputParams, binding) : inputParams;
    const approved = isBrowserStewardRuntimeApproved(publicParams, opts?.approvalAuthority);
    const browserStewardGatewayApproval = approved
      ? (request: Parameters<typeof createBrowserStewardGatewayApprovalClaim>[0]) =>
          createBrowserStewardGatewayApprovalClaim(request)
      : undefined;
    const approvedBinding = approved
      ? getBrowserStewardRuntimeApprovalBinding(publicParams, opts?.approvalAuthority)
      : undefined;
    const appliesBrowserStewardRuntimeGuard = shouldApplyBrowserStewardRuntimeGuard({
      sessionKey: opts?.agentSessionKey,
      agentId: opts?.agentId,
    });
    let browserStewardRuntimeDecision: BrowserStewardRuntimeDecision | undefined;
    if (appliesBrowserStewardRuntimeGuard) {
      const policyParams = resolveBrowserStewardRuntimePolicyParams(
        publicParams,
        opts?.approvalAuthority,
      );
      browserStewardRuntimeDecision = assertBrowserStewardRuntimeAllowed({
        action: readStringParam(publicParams, "action", { required: true }),
        profile: readStringParam(publicParams, "profile"),
        agentSessionKey: opts?.agentSessionKey,
        agentId: opts?.agentId,
        approved,
        request: policyParams.request ?? policyParams,
      });
    }
    const effectiveParams = approved
      ? resolveBrowserStewardRuntimeApprovedParams(publicParams, opts?.approvalAuthority)
      : publicParams;
    const action = readStringParam(effectiveParams, "action", { required: true });
    if (!capabilities.actions.some((candidate) => candidate === action)) {
      throw new Error(
        `browser action ${JSON.stringify(action)} is unavailable for this run; use an available action such as snapshot, or select a managed browser profile in an unbound run.`,
      );
    }
    const requestedProfile = readStringParam(effectiveParams, "profile");
    const requestedNode = readStringParam(effectiveParams, "node");
    const requestedTimeoutMs = readToolTimeoutMs(effectiveParams);
    const requestedTarget = readStringParam(effectiveParams, "target");
    let target: "sandbox" | "host" | "node" | undefined;
    if (requestedTarget === "sandbox" || requestedTarget === "host" || requestedTarget === "node") {
      target = requestedTarget;
    }
    const runtimeConfig = getRuntimeConfig();
    const resolvedBrowser = resolveBrowserConfig(runtimeConfig.browser, runtimeConfig);
    const effectiveProfile = requestedProfile ?? resolvedBrowser.defaultProfile;
    const resolvedProfile = resolveProfile(resolvedBrowser, effectiveProfile);
    const profileCapabilities = resolvedProfile
      ? getBrowserProfileCapabilities(resolvedProfile)
      : undefined;
    let profile = profileCapabilities?.usesChromeMcp ? effectiveProfile : requestedProfile;
    const configuredNode = runtimeConfig.gateway?.nodes?.browser?.node?.trim();

    if (requestedNode && target && target !== "node") {
      throw new Error('node is only supported with target="node".');
    }

    // System-profile import reads the local macOS Keychain and Chrome profile,
    // so it can only run on the host. Pin it before target/node resolution so a
    // sandbox default or auto-selected browser node never receives the request.
    if (action === "importprofile") {
      if (target === "sandbox" || target === "node" || requestedNode) {
        throw new Error(
          'system profile import must run on the host; omit target or use target="host".',
        );
      }
      target = "host";
    }
    // existing-session profiles can attach through the selected host or browser node,
    // but they must never fall back into the sandbox browser.
    const isUserBrowserProfile = profileCapabilities?.usesChromeMcp === true;
    if (isUserBrowserProfile) {
      if (target === "sandbox") {
        throw new Error(
          `profile="${profile}" cannot use the sandbox browser; use target="host" or omit target.`,
        );
      }
    }

    let nodeTarget: BrowserNodeTarget | null = null;
    try {
      nodeTarget = await resolveBrowserToolNodeTarget({
        requestedNode: requestedNode ?? undefined,
        target,
        sandboxBridgeUrl: opts?.sandboxBridgeUrl,
        allowHostControl: opts?.allowHostControl,
        signal,
      });
    } catch (error) {
      signal?.throwIfAborted();
      // Keep the logged-in user browser usable on the host when auto-discovery
      // of browser nodes fails transiently. Explicit node requests still fail.
      if (!(isUserBrowserProfile && !target && !requestedNode && !configuredNode)) {
        throw error;
      }
    }
    if (isUserBrowserProfile && !target && !requestedNode && !nodeTarget) {
      target = "host";
    }

    const resolvedTarget = target === "node" ? undefined : target;
    const baseUrl = nodeTarget
      ? undefined
      : resolveBrowserBaseUrl({
          target: resolvedTarget,
          sandboxBridgeUrl: opts?.sandboxBridgeUrl,
          allowHostControl: opts?.allowHostControl,
        });

    if (approved) {
      if (nodeTarget && approvedBinding?.browserNodeSessionLease) {
        await acquireBrowserNodeSessionLease(
          nodeTarget.nodeId,
          signal,
          approvedBinding.browserNodeSessionLease,
        );
      }
      const actualBinding = resolveBrowserStewardRuntimeApprovalBinding({
        ...publicParams,
        target: nodeTarget ? "node" : (target ?? (opts?.sandboxBridgeUrl ? "sandbox" : "host")),
        ...(nodeTarget ? { node: nodeTarget.nodeId, targetRef: nodeTarget.nodeId } : {}),
        ...(baseUrl ? { origin: baseUrl } : {}),
        ...(approvedBinding?.browserNodeSessionLease
          ? { browserNodeSessionLease: approvedBinding.browserNodeSessionLease }
          : {}),
        ...(nodeTarget
          ? action === "profiles"
            ? {}
            : { profile: requestedProfile ?? effectiveProfile }
          : { profile: effectiveProfile }),
      });
      if (
        !approvedBinding ||
        !matchesBrowserStewardRuntimeApprovalBindingAtExecution(approvedBinding, actualBinding)
      ) {
        throw new Error("Browser Steward approval route changed; request approval again");
      }
    }

    const allowAutomaticHostFallback = Boolean(
      nodeTarget &&
      !approved &&
      !target &&
      !requestedNode &&
      !configuredNode &&
      opts?.allowHostControl !== false,
    );
    const proxyRequest = nodeTarget
      ? createBrowserNodeProxyRequest({
          nodeTarget,
          allowAutomaticHostFallback,
          agentSessionKey: opts?.agentSessionKey,
          agentId: opts?.agentId,
          browserNodeSessionLease: approvedBinding?.browserNodeSessionLease,
          browserStewardGatewayApproval,
          signal,
        })
      : null;
    if (proxyRequest) {
      // Normal node requests resolve omissions on the node; approved Steward
      // requests pin the profile before approval so the effect cannot drift.
      profile = browserStewardRuntimeDecision
        ? action === "profiles"
          ? undefined
          : (requestedProfile ?? effectiveProfile)
        : requestedProfile;
    }
    if (
      !proxyRequest &&
      isUserBrowserProfile &&
      ["requests", "errors", "text", "emulate"].includes(action)
    ) {
      throw new Error(
        `action=${action} is not supported for existing-session profiles; use action=snapshot to inspect this page, or select a managed browser profile for ${action}.`,
      );
    }
    const nodeRoute = nodeTarget
      ? createBrowserNodeSessionTabRoute({
          nodeTarget,
          agentSessionKey: opts?.agentSessionKey,
          agentId: opts?.agentId,
          browserNodeSessionLease: approvedBinding?.browserNodeSessionLease,
          browserStewardGatewayApproval,
          browserOwnedGatewayRequest: opts?.browserOwnedGatewayRequest,
        })
      : undefined;
    const toolTimeoutMs = resolveBrowserToolTimeoutMs({
      requestedTimeoutMs,
      action,
      isUserBrowserProfile,
      resolvedBrowser,
    });
    const sessionTabs = createBrowserToolSessionTabs({
      sessionKey: opts?.agentSessionKey,
      requestedProfile: profile,
      defaultProfile: resolvedBrowser.defaultProfile,
      baseUrl,
      nodeRoute,
      routeProfile: () => {
        const route = proxyRequest?.route();
        return route?.status === "resolved" ? route.profile : undefined;
      },
      isHostFallbackActive: proxyRequest?.isHostFallbackActive,
      registry: { touchSessionBrowserTab, trackSessionBrowserTab, untrackSessionBrowserTab },
      ...(browserStewardRuntimeDecision ? { browserStewardRuntimeDecision } : {}),
    });
    const executeTrackedTabRequest = async (
      path: string,
      body: Record<string, unknown>,
      runLocal: () => Promise<unknown>,
    ) => {
      const result = proxyRequest
        ? await proxyRequest({ method: "POST", path, profile, body })
        : await runLocal();
      sessionTabs.touch(
        readStringValue(asNullableRecord(result)?.targetId) ?? readStringValue(body.targetId),
      );
      return jsonResult(result);
    };

    switch (action) {
      case "doctor":
      case "status":
      case "start":
      case "stop":
      case "profiles":
      case "importprofile":
        return await executeBrowserLifecycleAction({
          action,
          input: effectiveParams,
          baseUrl,
          profile,
          timeoutMs: toolTimeoutMs,
          proxyRequest,
          allowHostControl: opts?.allowHostControl,
          sandboxBridgeUrl: opts?.sandboxBridgeUrl,
          signal,
        });
      case "tabs":
        return await executeTabsAction({
          baseUrl,
          profile,
          timeoutMs: toolTimeoutMs,
          proxyRequest,
          targetId: binding?.targetId,
          signal,
        });
      case "open": {
        const targetUrl = readTargetUrlParam(effectiveParams);
        const label = normalizeOptionalString(effectiveParams.label);
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
        return formatBrowserExternalToolResult({
          kind: "tabs",
          payload: stripBrowserOpenInternalMetadata(opened),
        });
      }
      case "focus": {
        const targetId = readStringParam(effectiveParams, "targetId", {
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
        sessionTabs.touch(readStringValue(asNullableRecord(result)?.targetId) ?? targetId);
        return jsonResult(result);
      }
      case "close": {
        const targetId = readStringParam(effectiveParams, "targetId");
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
          input: effectiveParams,
          baseUrl,
          profile,
          proxyRequest,
          signal,
          onTabActivity: sessionTabs.touch,
        });
      case "screenshot":
        return await executeScreenshotAction({
          input: effectiveParams,
          baseUrl,
          profile,
          requestedTimeoutMs,
          proxyRequest,
          signal,
          onTabActivity: sessionTabs.touch,
          opts,
        });
      case "navigate": {
        const targetUrl = readTargetUrlParam(effectiveParams);
        const targetId = readStringParam(effectiveParams, "targetId");
        const timeoutMs =
          requestedTimeoutMs === undefined
            ? undefined
            : resolveBrowserNavigationTimeoutMs(requestedTimeoutMs);
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
              timeoutMs,
            })
          : await browserNavigate(baseUrl, {
              url: targetUrl,
              targetId,
              timeoutMs,
              profile,
              signal,
            });
        const navigatedTargetId = readStringValue(asNullableRecord(result)?.targetId) ?? targetId;
        sessionTabs.touch(navigatedTargetId);
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
          input: effectiveParams,
          baseUrl,
          profile,
          proxyRequest,
          signal,
        });
        const targetId = readStringParam(effectiveParams, "targetId");
        const canonicalTargetId = readStringValue(asNullableRecord(result.details)?.targetId);
        sessionTabs.touch(canonicalTargetId ?? targetId);
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
        const result = await execute({
          input: effectiveParams,
          baseUrl,
          profile,
          proxyRequest,
          signal,
        });
        sessionTabs.touch(
          readStringValue(asNullableRecord(result.details)?.targetId) ??
            readStringValue(effectiveParams.targetId),
        );
        return result;
      }
      case "pdf": {
        const targetId = normalizeOptionalString(effectiveParams.targetId);
        const result = proxyRequest
          ? await proxyRequest({
              method: "POST",
              path: "/pdf",
              profile,
              body: { targetId },
            })
          : await browserPdfSave(baseUrl, { targetId, profile, signal });
        const resultRecord = asNullableRecord(result);
        const resultPath = readStringValue(resultRecord?.path);
        if (!resultPath) {
          throw new Error("browser PDF response missing path");
        }
        sessionTabs.touch(readStringValue(resultRecord?.targetId) ?? targetId);
        return {
          content: [{ type: "text" as const, text: `FILE:${resultPath}` }],
          details: result,
        };
      }
      case "download":
      case "waitfordownload":
        return await executeDownloadAction({
          action,
          input: effectiveParams,
          baseUrl,
          profile,
          proxyRequest,
          signal,
          onTabActivity: sessionTabs.touch,
        });
      case "upload": {
        const paths = Array.isArray(effectiveParams.paths)
          ? effectiveParams.paths.map((p) => String(p))
          : [];
        if (paths.length === 0) {
          throw new Error("paths required");
        }
        const resolvedResult = await resolveExistingUploadPaths({ requestedPaths: paths });
        if (!resolvedResult.ok) {
          throw new Error(resolvedResult.error);
        }
        const normalizedPaths = resolvedResult.paths;
        const ref = readStringParam(effectiveParams, "ref");
        const inputRef = readStringParam(effectiveParams, "inputRef");
        const element = readStringParam(effectiveParams, "element");
        const { targetId, timeoutMs } = readOptionalTargetAndTimeout(effectiveParams);
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
        const accept = Boolean(effectiveParams.accept);
        const promptText = readStringValue(effectiveParams.promptText);
        const dialogId = readStringValue(effectiveParams.dialogId);
        const { targetId, timeoutMs } = readOptionalTargetAndTimeout(effectiveParams);
        const request = { accept, promptText, dialogId, targetId, timeoutMs };
        return await executeTrackedTabRequest(
          "/hooks/dialog",
          request,
          async () => await browserArmDialog(baseUrl, { ...request, profile, signal }),
        );
      }
      case "act": {
        const request = readActRequestParam(effectiveParams);
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
          onTabActivity: sessionTabs.touch,
          onTabClose: sessionTabs.untrack,
        });
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  };
}
