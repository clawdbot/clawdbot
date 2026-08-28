/**
 * Gateway handler for browser.request, including optional node-host proxy
 * dispatch and local Browser control route dispatch.
 */
import crypto from "node:crypto";
import { clampTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { BROWSER_REQUEST_GATEWAY_SCOPE } from "../browser-gateway-contract.js";
import {
  BROWSER_PROXY_COMMAND,
  BROWSER_PROXY_UPLOAD_COMMAND,
  browserProxyUploadUnavailableMessage,
} from "../browser-node-commands.js";
import { isBrowserControlHostUnavailableError } from "../browser-node-fallback.js";
import { resolveBrowserNodeTarget } from "../browser-node-routing.js";
import {
  BROWSER_PROXY_ERROR_ENVELOPE,
  createBrowserProxyFailure,
  parseBrowserProxyFailure,
  type BrowserProxyEnvelope,
  type BrowserProxySuccess,
  type BrowserProxyUploadV1,
} from "../browser-proxy-envelope.js";
import {
  isBrowserProxyUploadRequest,
  prepareBrowserProxyUploadRequest,
} from "../browser-proxy-upload.js";
import {
  consumeBrowserStewardGatewayApprovalClaimAuthority,
  createBrowserStewardGatewayApproval,
  type BrowserStewardGatewayApprovalAuthority,
} from "../browser/browser-steward-approval.js";
import {
  assertBrowserStewardRuntimeAllowed,
  BROWSER_STEWARD_AGENT_ID,
  resolveBrowserStewardProxyAction,
  shouldApplyBrowserStewardRuntimeGuard,
} from "../browser/browser-steward-runtime-guard.js";
import { normalizeBrowserRequestPath } from "../browser/request-policy.js";
import {
  ErrorCodes,
  createBrowserControlContext,
  createBrowserRouteDispatcher,
  errorShape,
  getRuntimeConfig,
  isBrowserHostLocalRoute,
  isNodeCommandAllowed,
  isPersistentBrowserProfileMutation,
  persistBrowserProxyResultFiles,
  resolveBrowserConfig,
  resolveNodeCommandAllowlist,
  resolveRequestedBrowserProfile,
  respondUnavailableOnNodeInvokeError,
  safeParseJson,
  startBrowserControlServiceFromConfig,
  withTimeout,
  type GatewayRequestHandlers,
  type NodeSession,
} from "../core-api.js";

const logger = createSubsystemLogger("browser");

type BrowserGatewayRequestOptions = Parameters<GatewayRequestHandlers["browser.request"]>[0];

function hasActiveBrowserNodeRuntimeAuthority(
  client: Parameters<GatewayRequestHandlers["browser.request"]>[0]["client"],
  context: Parameters<GatewayRequestHandlers["browser.request"]>[0]["context"],
): boolean {
  const pluginAuthority = client?.internal?.pluginRuntimeAuthority;
  if (pluginAuthority) {
    try {
      if (!pluginAuthority()) {
        return false;
      }
    } catch {
      return false;
    }
  }
  const identity = client?.internal?.agentRuntimeIdentity;
  return !identity || context.validateAgentRuntimeApprovalAuthority?.(identity) === true;
}

type BrowserRequestParams = {
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  upload?: BrowserProxyUploadV1;
  timeoutMs?: number;
  profile?: string;
  browserProxyTimeoutMs?: number;
  agentSessionKey?: string;
  agentId?: string;
  /** Internal Browser tool route selection; never supplied by model arguments. */
  nodeId?: string;
  /** Internal opaque lease binding one approved Browser tool call to a node session. */
  browserNodeSessionLease?: string;
  /** Internal pre-approval route lease request; never supplied by model arguments. */
  routeOnly?: boolean;
  /** Internal post-approval renewal of the same exact route lease. */
  renewBrowserNodeSessionLease?: boolean;
  /** Prevent a node-bound Browser tool call from changing backend after approval. */
  allowAutomaticHostFallback?: boolean;
  /** Internal response envelope for Browser tool route tracking. */
  includeRoute?: boolean;
};

/** Handles one browser.request gateway call and streams a success/error response. */
export async function handleBrowserGatewayRequest(options: BrowserGatewayRequestOptions) {
  const authority = options.client?.internal?.agentRuntimeIdentity?.delegatedAuthority;
  const registerAuthorityClosed = options.context.registerAgentRuntimeAuthorityClosed;
  if (!authority || !registerAuthorityClosed) {
    return await handleBrowserGatewayRequestInternal(options);
  }

  const authorityAbortController = new AbortController();
  let unregisterAuthorityClosed: (() => void) | undefined;
  try {
    unregisterAuthorityClosed = registerAuthorityClosed(authority, () => {
      authorityAbortController.abort(new Error("agent runtime authority closed"));
    });
  } catch {
    options.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime authority unavailable"),
    );
    return;
  }

  const signal = options.signal
    ? AbortSignal.any([options.signal, authorityAbortController.signal])
    : authorityAbortController.signal;
  try {
    return await handleBrowserGatewayRequestInternal({ ...options, signal });
  } finally {
    unregisterAuthorityClosed?.();
  }
}

async function handleBrowserGatewayRequestInternal({
  params,
  respond,
  context,
  client,
  signal,
}: BrowserGatewayRequestOptions) {
  const typed = params as BrowserRequestParams;
  const methodRaw = (normalizeOptionalString(typed.method) ?? "").toUpperCase();
  const path = normalizeOptionalString(typed.path) ?? "";
  const query = typed.query && typeof typed.query === "object" ? typed.query : undefined;
  const body = typed.body;
  const timeoutMs = clampTimerTimeoutMs(typed.timeoutMs);
  const requestedNode = normalizeOptionalString(typed.nodeId);
  const browserNodeSessionLease = normalizeOptionalString(typed.browserNodeSessionLease);
  const routeOnly = typed.routeOnly === true;
  const operatorAdmin = client?.connect?.scopes?.includes(BROWSER_REQUEST_GATEWAY_SCOPE) === true;
  const trustedAgentRuntime = client?.internal?.agentRuntimeIdentity;
  const trustedAgentId = normalizeOptionalString(trustedAgentRuntime?.agentId);
  const trustedAgentSessionKey = normalizeOptionalString(trustedAgentRuntime?.sessionKey);
  const browserStewardOperationClaim = trustedAgentRuntime?.gatewayToolOperationApproval;
  const hasBrowserStewardOperationClaim = browserStewardOperationClaim?.owner === "browser";
  const pluginRuntimeOwnerId = normalizeOptionalString(client?.internal?.pluginRuntimeOwnerId);
  const browserPluginRuntime = pluginRuntimeOwnerId === "browser";
  // This fact is host-issued by trusted in-process dispatch; the wire marker
  // is stripped before reaching this handler and cannot grant the authority.
  const compatibilityMeetingRuntime = client?.internal?.browserRequestCompatibility === true;
  if (pluginRuntimeOwnerId && !browserPluginRuntime && !compatibilityMeetingRuntime) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "browser control requires a Browser-owned capability"),
    );
    return;
  }
  // Agent-runtime identity is authoritative. Request fields are only caller
  // hints for direct Gateway callers and must not turn an agent into an operator.
  const effectiveRequestedAgentId = trustedAgentRuntime ? trustedAgentId : typed.agentId;
  const effectiveRequestedAgentSessionKey = trustedAgentRuntime
    ? trustedAgentSessionKey
    : typed.agentSessionKey;
  const directOperator =
    !pluginRuntimeOwnerId &&
    !trustedAgentRuntime &&
    operatorAdmin &&
    !effectiveRequestedAgentSessionKey?.trim() &&
    !effectiveRequestedAgentId?.trim();
  const appliesBrowserStewardGuard =
    shouldApplyBrowserStewardRuntimeGuard({
      sessionKey: effectiveRequestedAgentSessionKey,
      agentId: effectiveRequestedAgentId,
    }) ||
    browserPluginRuntime ||
    compatibilityMeetingRuntime ||
    directOperator;
  const effectiveAgentId =
    browserPluginRuntime || compatibilityMeetingRuntime || directOperator
      ? BROWSER_STEWARD_AGENT_ID
      : effectiveRequestedAgentId;
  const effectiveAgentSessionKey =
    browserPluginRuntime || compatibilityMeetingRuntime || directOperator
      ? undefined
      : effectiveRequestedAgentSessionKey;
  const operatorApproved = operatorAdmin && !trustedAgentRuntime;
  let browserStewardOperationApproved =
    operatorApproved || browserPluginRuntime || hasBrowserStewardOperationClaim;
  let browserStewardOperationAuthority: BrowserStewardGatewayApprovalAuthority | undefined;
  const requestedProfile = resolveRequestedBrowserProfile({
    query,
    body,
    profile: typed.profile,
  });
  const cfg = getRuntimeConfig();
  const isBrowserNodeDispatchAuthorized = () =>
    !signal?.aborted && hasActiveBrowserNodeRuntimeAuthority(client, context);

  if (routeOnly) {
    if (!operatorAdmin) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "browser route leasing requires operator admin authority",
        ),
      );
      return;
    }
    if (!requestedNode) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    let nodeTarget: NodeSession | null;
    try {
      nodeTarget = resolveBrowserNodeTarget({
        nodes: context.nodeRegistry.listConnected(),
        policy: cfg.gateway?.nodes?.browser,
        requestedNode,
        explicitTarget: true,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
      return;
    }
    if (!nodeTarget) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "No connected browser-capable nodes."),
      );
      return;
    }
    const lease = typed.renewBrowserNodeSessionLease
      ? browserNodeSessionLease
        ? context.nodeRegistry.renewBrowserNodeSessionLease(
            nodeTarget.nodeId,
            browserNodeSessionLease,
          )
          ? browserNodeSessionLease
          : undefined
        : undefined
      : context.nodeRegistry.createBrowserNodeSessionLease(nodeTarget.nodeId);
    if (!lease) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "browser node pairing authority unavailable"),
      );
      return;
    }
    respond(true, { browserNodeSessionLease: lease, nodeId: nodeTarget.nodeId }, undefined);
    return;
  }

  if (!methodRaw || !path) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "method and path are required"),
    );
    return;
  }
  if (methodRaw !== "GET" && methodRaw !== "POST" && methodRaw !== "DELETE") {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "method must be GET, POST, or DELETE"),
    );
    return;
  }
  if (appliesBrowserStewardGuard) {
    try {
      assertBrowserStewardRuntimeAllowed({
        action: resolveBrowserStewardProxyAction({ method: methodRaw, path, body }),
        profile: requestedProfile,
        agentSessionKey: effectiveAgentSessionKey,
        agentId: effectiveAgentId,
        approved: browserStewardOperationApproved,
        request: body,
      });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(error)));
      return;
    }
  }
  const normalizedPath = normalizeBrowserRequestPath(path);
  const stewardProfile = appliesBrowserStewardGuard
    ? normalizedPath === "/profiles"
      ? ""
      : (requestedProfile ?? resolveBrowserConfig(cfg.browser, cfg).defaultProfile)
    : requestedProfile;
  const configuredNode = normalizeOptionalString(cfg.gateway?.nodes?.browser?.node);
  // System-profile listing and import can only run where the local Keychain and
  // Chrome profiles live, so they must never route to a browser node. Force
  // host-local dispatch even when gateway.nodes.browser auto-selects a node.
  const forceHostLocal = isBrowserHostLocalRoute(methodRaw, path);
  let nodeTarget: NodeSession | null = null;
  if (!forceHostLocal) {
    try {
      nodeTarget = resolveBrowserNodeTarget({
        nodes: context.nodeRegistry.listConnected(),
        policy: cfg.gateway?.nodes?.browser,
        requestedNode,
        explicitTarget: requestedNode !== undefined,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
      return;
    }
  }

  if (nodeTarget && isPersistentBrowserProfileMutation(methodRaw, path)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "browser.request cannot mutate persistent browser profiles over a node proxy",
      ),
    );
    return;
  }
  if (browserNodeSessionLease) {
    if (
      !operatorAdmin ||
      !appliesBrowserStewardGuard ||
      !nodeTarget ||
      !context.nodeRegistry.resolveBrowserNodeSessionLease(
        nodeTarget.nodeId,
        browserNodeSessionLease,
      )
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "browser node route lease is stale; request approval again",
        ),
      );
      return;
    }
  }

  const requestsUpload =
    typed.upload !== undefined || isBrowserProxyUploadRequest({ method: methodRaw, path, body });
  let preparedUpload: Awaited<ReturnType<typeof prepareBrowserProxyUploadRequest>> | null = null;
  // Select the node command before capability checks and approval fingerprints.
  const proxyCommand = requestsUpload ? BROWSER_PROXY_UPLOAD_COMMAND : BROWSER_PROXY_COMMAND;
  if (nodeTarget) {
    if (requestsUpload && !nodeTarget.commands?.includes(BROWSER_PROXY_UPLOAD_COMMAND)) {
      const message = browserProxyUploadUnavailableMessage(nodeTarget.declaredCommands);
      if (configuredNode || typed.allowAutomaticHostFallback === false || browserNodeSessionLease) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
        return;
      }
      logger.warn(
        `browser node ${nodeTarget.displayName ?? nodeTarget.nodeId} lacks ${BROWSER_PROXY_UPLOAD_COMMAND}; falling back to Gateway host`,
      );
      nodeTarget = null;
    }
  }
  if (browserNodeSessionLease && !nodeTarget) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "browser node route lease is stale; request approval again",
      ),
    );
    return;
  }
  if (nodeTarget) {
    try {
      preparedUpload =
        typed.upload === undefined
          ? await prepareBrowserProxyUploadRequest({
              method: methodRaw,
              path,
              body,
            })
          : { body, upload: typed.upload };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
      return;
    }
  }

  if (hasBrowserStewardOperationClaim) {
    browserStewardOperationAuthority = consumeBrowserStewardGatewayApprovalClaimAuthority({
      approval: browserStewardOperationClaim,
      command: proxyCommand,
      method: methodRaw,
      path,
      query,
      body: preparedUpload?.body ?? body,
      upload: preparedUpload?.upload ?? typed.upload,
      profile: typed.profile,
      agentSessionKey: effectiveAgentSessionKey,
      agentId: effectiveAgentId,
      nodeId: requestedNode,
      browserNodeSessionLease,
      allowAutomaticHostFallback: typed.allowAutomaticHostFallback,
    });
    browserStewardOperationApproved = browserStewardOperationAuthority !== undefined;
    try {
      assertBrowserStewardRuntimeAllowed({
        action: resolveBrowserStewardProxyAction({ method: methodRaw, path, body }),
        profile: requestedProfile,
        agentSessionKey: effectiveAgentSessionKey,
        agentId: effectiveAgentId,
        approved: browserStewardOperationApproved,
        request: body,
      });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(error)));
      return;
    }
  }

  if (nodeTarget && preparedUpload) {
    const allowlist = resolveNodeCommandAllowlist(cfg, nodeTarget);
    const allowed = isNodeCommandAllowed({
      command: proxyCommand,
      declaredCommands: nodeTarget.commands,
      allowlist,
    });
    if (!allowed.ok) {
      const platform = nodeTarget.platform ?? "unknown";
      const hint = `node command not allowed: ${allowed.reason} (platform: ${platform}, command: ${proxyCommand})`;
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, hint, {
          details: { reason: allowed.reason, command: proxyCommand },
        }),
      );
      return;
    }

    const idempotencyKey = crypto.randomUUID();
    if (operatorAdmin && !nodeTarget.pairingGeneration) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "browser node pairing authority unavailable"),
      );
      return;
    }
    const proxyParams = {
      method: methodRaw,
      path,
      query,
      body: preparedUpload.body,
      upload: preparedUpload.upload,
      timeoutMs: typed.browserProxyTimeoutMs ?? timeoutMs,
      profile: appliesBrowserStewardGuard ? stewardProfile : requestedProfile,
      agentSessionKey: effectiveAgentSessionKey,
      agentId: effectiveAgentId,
      ...(browserStewardOperationApproved && appliesBrowserStewardGuard
        ? {
            browserStewardApproval: createBrowserStewardGatewayApproval({
              command: proxyCommand,
              method: methodRaw,
              path,
              query,
              body: preparedUpload.body,
              upload: preparedUpload.upload,
              profile: stewardProfile,
              agentSessionKey: effectiveAgentSessionKey,
              agentId: effectiveAgentId,
              nodeId: nodeTarget.nodeId,
              pairingGeneration: nodeTarget.pairingGeneration ?? "",
              invocationId: idempotencyKey,
            }),
          }
        : {}),
      errorEnvelope: BROWSER_PROXY_ERROR_ENVELOPE,
    };
    if (!isBrowserNodeDispatchAuthorized()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime authority is no longer active"),
      );
      return;
    }
    const res = await context.nodeRegistry.invoke({
      nodeId: nodeTarget.nodeId,
      expectedConnId: nodeTarget.connId,
      expectedPairingGeneration: nodeTarget.pairingGeneration,
      command: proxyCommand,
      params: proxyParams,
      timeoutMs,
      idempotencyKey,
      isDispatchAuthorized: isBrowserNodeDispatchAuthorized,
      signal,
    });
    if (!res.ok && !isBrowserNodeDispatchAuthorized()) {
      // A failed dispatch still needs an active authority before any retry or
      // host fallback decision; a completed result must remain observable.
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime authority is no longer active"),
      );
      return;
    }
    const automaticHostFallbackRequested =
      typed.allowAutomaticHostFallback === true ||
      (typed.allowAutomaticHostFallback === undefined &&
        !configuredNode &&
        requestedNode === undefined);
    const browserNodeRoutePinned =
      browserPluginRuntime ||
      compatibilityMeetingRuntime ||
      hasBrowserStewardOperationClaim ||
      browserNodeSessionLease !== undefined;
    const allowAutomaticHostFallback =
      automaticHostFallbackRequested &&
      !browserNodeRoutePinned &&
      isBrowserControlHostUnavailableError(res.error);
    if (allowAutomaticHostFallback && !res.ok) {
      // This node-host error is raised before route dispatch. Other failures
      // stay on the node path because retrying could duplicate an action.
      logger.warn(
        `browser node ${nodeTarget.displayName ?? nodeTarget.nodeId} control host unavailable; falling back to Gateway host`,
      );
    } else {
      if (typed.includeRoute && !res.ok) {
        const payload = res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload;
        const structuredFailure = parseBrowserProxyFailure(payload);
        if (structuredFailure) {
          respond(true, structuredFailure, undefined);
          return;
        }
        const nodeMessage = normalizeOptionalString(res.error?.message);
        const statusMatch = /^(?:[A-Z_]+:\s*)?(\d{3}):\s*(.+)$/.exec(nodeMessage ?? "");
        const status = statusMatch ? Number(statusMatch[1]) : 502;
        const message = statusMatch?.[2] ?? nodeMessage ?? "browser proxy failed";
        respond(true, createBrowserProxyFailure(status, { error: message }), undefined);
        return;
      }
      if (!respondUnavailableOnNodeInvokeError(respond, res)) {
        return;
      }
      const payload = res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload;
      const failure = parseBrowserProxyFailure(payload);
      if (failure) {
        const { status, body: errorBody } = failure.error;
        const code = status >= 500 ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST;
        respond(false, undefined, errorShape(code, errorBody.error, { details: errorBody }));
        return;
      }
      const proxy =
        payload && typeof payload === "object" ? (payload as BrowserProxyEnvelope) : null;
      if (!proxy || !("result" in proxy)) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "browser proxy failed"));
        return;
      }
      const success = proxy as BrowserProxySuccess;
      try {
        const result = await persistBrowserProxyResultFiles(success.result, success.files);
        respond(
          true,
          typed.includeRoute
            ? {
                result,
                ...(success.route ? { route: success.route } : {}),
              }
            : result,
        );
      } catch {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "browser proxy file transfer failed"),
        );
      }
      return;
    }
  }

  const isBrowserHostDispatchAuthorized = () =>
    isBrowserNodeDispatchAuthorized() && (browserStewardOperationAuthority?.isActive() ?? true);
  if (!isBrowserHostDispatchAuthorized()) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime authority is no longer active"),
    );
    return;
  }

  // `browser.request` already requires operator.admin. The owning host may run
  // profile administration; the node-proxy branch above stays denied because
  // `browser.proxy` is a separate remote-host authority.
  const ready = await startBrowserControlServiceFromConfig();
  if (!ready) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "browser control is disabled"));
    return;
  }
  if (!isBrowserHostDispatchAuthorized()) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime authority is no longer active"),
    );
    return;
  }

  let dispatcher;
  try {
    dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    return;
  }

  let result;
  try {
    if (!isBrowserHostDispatchAuthorized()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime authority is no longer active"),
      );
      return;
    }
    result = timeoutMs
      ? await withTimeout(
          (timeoutSignal) => {
            const dispatchSignal = signal
              ? timeoutSignal
                ? AbortSignal.any([signal, timeoutSignal])
                : signal
              : timeoutSignal;
            return dispatcher.dispatch({
              method: methodRaw,
              path,
              query,
              body,
              ...(dispatchSignal ? { signal: dispatchSignal } : {}),
            });
          },
          timeoutMs,
          "browser request",
        )
      : await dispatcher.dispatch({
          method: methodRaw,
          path,
          query,
          body,
          ...(signal ? { signal } : {}),
        });
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    return;
  }

  if (result.status >= 400) {
    const message =
      result.body && typeof result.body === "object" && "error" in result.body
        ? String((result.body as { error?: unknown }).error)
        : `browser request failed (${result.status})`;
    const code = result.status >= 500 ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST;
    respond(false, undefined, errorShape(code, message, { details: result.body }));
    return;
  }

  respond(
    true,
    typed.includeRoute ? { result: result.body, route: { status: "host-fallback" } } : result.body,
  );
}

/** Gateway request handler map contributed by the Browser plugin. */
export const browserHandlers: GatewayRequestHandlers = {
  "browser.request": handleBrowserGatewayRequest,
};
