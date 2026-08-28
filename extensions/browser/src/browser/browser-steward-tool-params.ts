import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  applyBrowserTabToolBindingToParams,
  type BrowserTabToolBinding,
} from "../browser-tool-binding.js";
import {
  resolveBrowserBaseUrl,
  resolveBrowserToolNodeTarget,
  type BrowserNodeTarget,
} from "../browser-tool.routing.js";
import {
  callGatewayTool,
  getBrowserProfileCapabilities,
  getRuntimeConfig,
  resolveBrowserConfig,
  resolveProfile,
} from "../browser-tool.runtime.js";
import {
  prepareBrowserStewardRuntimeParams,
  resolveBrowserStewardRuntimeApprovalBinding,
  type BrowserStewardRuntimeApprovalAuthority,
  type BrowserStewardRuntimeApprovalBinding,
} from "./browser-steward-approval.js";
import { shouldApplyBrowserStewardRuntimeGuard } from "./browser-steward-runtime-guard.js";

export async function acquireBrowserNodeSessionLease(
  nodeId: string,
  signal?: AbortSignal,
  existingLease?: string,
): Promise<string> {
  const response = await callGatewayTool(
    "browser.request",
    { timeoutMs: 10_000 },
    {
      routeOnly: true,
      nodeId,
      ...(existingLease
        ? {
            browserNodeSessionLease: existingLease,
            renewBrowserNodeSessionLease: true,
          }
        : {}),
    },
    { scopes: ["operator.admin"], ...(signal ? { signal } : {}) },
  );
  const envelope = response;
  let payload: unknown = envelope?.payload ?? response;
  if (payload === undefined && typeof envelope?.payloadJSON === "string") {
    try {
      payload = JSON.parse(envelope.payloadJSON);
    } catch {
      payload = undefined;
    }
  }
  const lease = isRecord(payload) ? payload.browserNodeSessionLease : undefined;
  if (typeof lease !== "string" || !lease.trim()) {
    throw new Error("browser node route lease unavailable");
  }
  return lease.trim();
}

async function resolveBrowserStewardToolBinding(params: {
  input: Record<string, unknown>;
  agentSessionKey?: string;
  agentId?: string;
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  signal?: AbortSignal;
}): Promise<BrowserStewardRuntimeApprovalBinding | undefined> {
  if (
    !shouldApplyBrowserStewardRuntimeGuard({
      sessionKey: params.agentSessionKey,
      agentId: params.agentId,
    })
  ) {
    return undefined;
  }
  const action = typeof params.input.action === "string" ? params.input.action.trim() : "";
  const requestedTargetValue =
    typeof params.input.target === "string" ? params.input.target.trim().toLowerCase() : "";
  const requestedTarget =
    requestedTargetValue === "sandbox"
      ? "sandbox"
      : requestedTargetValue === "host"
        ? "host"
        : requestedTargetValue === "node"
          ? "node"
          : "";
  const requestedNode =
    typeof params.input.node === "string" ? params.input.node.trim() : undefined;
  const requestedProfile =
    typeof params.input.profile === "string" ? params.input.profile.trim() : undefined;
  const runtimeConfig = getRuntimeConfig();
  const resolvedBrowser = resolveBrowserConfig(runtimeConfig.browser, runtimeConfig);
  const resolvedProfile = resolveProfile(
    resolvedBrowser,
    requestedProfile ?? resolvedBrowser.defaultProfile,
  );
  const isUserBrowserProfile = Boolean(
    resolvedProfile && getBrowserProfileCapabilities(resolvedProfile).usesChromeMcp,
  );
  let target: "sandbox" | "host" | "node" | "" = requestedTarget;
  if (action === "importprofile") {
    target = "host";
  }
  let nodeTarget: BrowserNodeTarget | null = null;
  if (target !== "host" && target !== "sandbox") {
    try {
      nodeTarget = await resolveBrowserToolNodeTarget({
        requestedNode,
        target: target || undefined,
        sandboxBridgeUrl: params.sandboxBridgeUrl,
        allowHostControl: params.allowHostControl,
        signal: params.signal,
      });
    } catch (error) {
      params.signal?.throwIfAborted();
      const configuredNode = runtimeConfig.gateway?.nodes?.browser?.node?.trim();
      if (!(isUserBrowserProfile && !target && !requestedNode && !configuredNode)) {
        throw error;
      }
    }
  }
  if (isUserBrowserProfile && !target && !requestedNode && !nodeTarget) {
    target = "host";
  }
  const browserNodeSessionLease = nodeTarget
    ? await acquireBrowserNodeSessionLease(nodeTarget.nodeId, params.signal)
    : undefined;
  const backendKind = nodeTarget
    ? "node"
    : target || (params.sandboxBridgeUrl ? "sandbox" : "host");
  const origin =
    backendKind === "node"
      ? undefined
      : resolveBrowserBaseUrl({
          target: backendKind === "sandbox" ? "sandbox" : "host",
          sandboxBridgeUrl: params.sandboxBridgeUrl,
          allowHostControl: params.allowHostControl,
        });
  const bindingInput = {
    ...params.input,
    target: backendKind,
    ...(nodeTarget ? { node: nodeTarget.nodeId, targetRef: nodeTarget.nodeId } : {}),
    ...(origin ? { origin } : {}),
    ...(browserNodeSessionLease ? { browserNodeSessionLease } : {}),
    ...(backendKind === "node"
      ? action === "profiles"
        ? {}
        : { profile: requestedProfile ?? resolvedBrowser.defaultProfile }
      : { profile: requestedProfile ?? resolvedBrowser.defaultProfile }),
  };
  return resolveBrowserStewardRuntimeApprovalBinding(bindingInput);
}

export async function prepareBrowserStewardToolParams(params: {
  input: unknown;
  agentSessionKey?: string;
  agentId?: string;
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  runToolBinding?: BrowserTabToolBinding;
  approvalAuthority?: BrowserStewardRuntimeApprovalAuthority;
  signal?: AbortSignal;
}): Promise<unknown> {
  const input =
    params.runToolBinding && params.input && typeof params.input === "object"
      ? applyBrowserTabToolBindingToParams(params.input, params.runToolBinding)
      : params.input;
  if (
    !shouldApplyBrowserStewardRuntimeGuard({
      sessionKey: params.agentSessionKey,
      agentId: params.agentId,
    })
  ) {
    return input;
  }
  const binding = isRecord(input)
    ? await resolveBrowserStewardToolBinding({
        input,
        agentSessionKey: params.agentSessionKey,
        agentId: params.agentId,
        sandboxBridgeUrl: params.sandboxBridgeUrl,
        allowHostControl: params.allowHostControl,
        signal: params.signal,
      })
    : undefined;
  return prepareBrowserStewardRuntimeParams(input, binding, params.approvalAuthority);
}
