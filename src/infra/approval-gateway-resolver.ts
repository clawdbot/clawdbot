// Resolves exec and plugin approvals through the gateway client.
import type {
  ApprovalChannelReviewer,
  ApprovalDecision,
  ApprovalResolveParams,
  ApprovalResolveResult,
} from "../../packages/gateway-protocol/src/index.js";
import { isWellFormedApprovalId } from "../../packages/gateway-protocol/src/schema/approvals.js";
import { findChatChannelLabel } from "../channels/ids.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOperatorApprovalsGatewayClient } from "../gateway/operator-approvals-client.js";
import { isApprovalNotFoundError } from "./approval-errors.js";
import { getGatewayNativeApprovalRuntime } from "./approval-gateway-runtime-context.js";
import type { GatewayNativeApprovalMethod } from "./approval-gateway-runtime-methods.js";
import type { ChannelApprovalKind } from "./approval-types.js";

type ResolveApprovalOverGatewayBaseParams = {
  cfg: OpenClawConfig;
  approvalId: string;
  decision: ApprovalDecision;
  channel?: string;
  accountId?: string | null;
  senderId?: string | null;
  gatewayUrl?: string;
  clientDisplayName?: string;
};

type ApprovalGatewayRuntime = {
  request: (
    method: "approval.resolve",
    params: ApprovalResolveParams,
    options?: { clientDisplayName?: string },
  ) => Promise<ApprovalResolveResult>;
};

type CanonicalResolveApprovalOverGatewayParams = ResolveApprovalOverGatewayBaseParams & {
  /** Explicit owner required by the canonical approval resolver. */
  approvalKind: ChannelApprovalKind;
  gatewayRuntime?: ApprovalGatewayRuntime;
  allowPluginFallback?: never;
  resolveMethod?: never;
};

/**
 * Shipped compatibility input for command-backed and older channel controls.
 * @deprecated Pass approvalKind so resolution uses the canonical approval service.
 */
type LegacyResolveApprovalOverGatewayParams = ResolveApprovalOverGatewayBaseParams & {
  approvalKind?: never;
  /**
   * Shipped legacy fallback after an exec lookup proves no match.
   * @deprecated Pass approvalKind so resolution uses the canonical approval service.
   */
  allowPluginFallback?: boolean;
  /**
   * Explicit legacy owner. Omission retains the shipped id-based routing contract.
   * @deprecated Pass approvalKind so resolution uses the canonical approval service.
   */
  resolveMethod?: ChannelApprovalKind;
};

type ResolveApprovalOverGatewayParams =
  | CanonicalResolveApprovalOverGatewayParams
  | LegacyResolveApprovalOverGatewayParams;

/**
 * Resolves a shipped legacy approval control through its kind-specific Gateway adapter.
 * @deprecated Pass approvalKind so resolution uses the canonical approval service.
 */
export function resolveApprovalOverGateway(
  params: LegacyResolveApprovalOverGatewayParams,
): Promise<void>;
/** Resolves a typed approval through the canonical operator approval service. */
export function resolveApprovalOverGateway(
  params: CanonicalResolveApprovalOverGatewayParams,
): Promise<ApprovalResolveResult>;
export async function resolveApprovalOverGateway(
  params: ResolveApprovalOverGatewayParams,
): Promise<ApprovalResolveResult | void> {
  const approvalKind = (params as { approvalKind?: unknown }).approvalKind;
  const resolveMethod = (params as { resolveMethod?: unknown }).resolveMethod;
  const canonicalKind = approvalKind === "exec" || approvalKind === "plugin" ? approvalKind : null;
  const legacyMethod =
    resolveMethod === "exec" || resolveMethod === "plugin" ? resolveMethod : null;
  const hasCanonicalKind = canonicalKind !== null;
  const hasLegacyMethod = legacyMethod !== null;
  const allowPluginFallback = (params as { allowPluginFallback?: unknown }).allowPluginFallback;
  const gatewayRuntime = (params as { gatewayRuntime?: unknown }).gatewayRuntime;
  if (approvalKind !== undefined) {
    if (!hasCanonicalKind || resolveMethod !== undefined || allowPluginFallback !== undefined) {
      throw new Error("canonical approval resolution requires exactly one valid owner kind");
    }
  } else if (
    (resolveMethod !== undefined && !hasLegacyMethod) ||
    (allowPluginFallback !== undefined && typeof allowPluginFallback !== "boolean") ||
    gatewayRuntime !== undefined
  ) {
    throw new Error("legacy approval resolution requires valid routing options");
  }
  if (
    params.decision !== "allow-once" &&
    params.decision !== "allow-always" &&
    params.decision !== "deny"
  ) {
    throw new Error("approval resolution requires a valid decision");
  }
  const approvalId = params.approvalId;
  if (typeof approvalId !== "string" || !isWellFormedApprovalId(approvalId)) {
    throw new Error("approval resolution requires an approval id");
  }
  const senderId = params.senderId?.trim();
  const channel = params.channel?.trim();
  const accountId = params.accountId?.trim();
  const hasReviewerIdentity = Boolean(channel || accountId || senderId);
  if (hasReviewerIdentity && (!channel || !accountId || !senderId)) {
    throw new Error("channel approval resolution requires channel, account, and sender identity");
  }
  const reviewer: ApprovalChannelReviewer | undefined =
    channel && accountId && senderId ? { channel, accountId, senderId } : undefined;
  // Channel manifests own operator-facing labels; using their generated metadata
  // keeps approval clients aligned without importing plugin runtime or hardcoding ids.
  const channelLabel = channel ? (findChatChannelLabel(channel) ?? channel) : undefined;
  const clientDisplayName =
    params.clientDisplayName ??
    (channelLabel
      ? `${channelLabel} approval (${senderId ?? "unknown"})`
      : `Approval (${senderId ?? "unknown"})`);

  const canonicalGatewayRuntime = (params as CanonicalResolveApprovalOverGatewayParams)
    .gatewayRuntime;
  if (canonicalGatewayRuntime && canonicalKind) {
    return await canonicalGatewayRuntime.request(
      "approval.resolve",
      {
        id: approvalId,
        kind: canonicalKind,
        decision: params.decision,
        ...(reviewer ? { reviewer } : {}),
      },
      { clientDisplayName },
    );
  }

  const requestWithClient = async (gatewayClient: {
    request: <T = unknown>(
      method: GatewayNativeApprovalMethod,
      params: Record<string, unknown>,
    ) => Promise<T>;
  }) => {
    if (hasCanonicalKind) {
      const resolveParams: ApprovalResolveParams = {
        id: approvalId,
        kind: canonicalKind,
        decision: params.decision,
        ...(reviewer ? { reviewer } : {}),
      };
      return await gatewayClient.request<ApprovalResolveResult>("approval.resolve", resolveParams);
    }

    const requestLegacyResolve = async (
      method: "exec.approval.resolve" | "plugin.approval.resolve",
    ): Promise<void> => {
      await gatewayClient.request(method, {
        id: approvalId,
        decision: params.decision,
        ...(reviewer ? { reviewer } : {}),
      });
    };
    if (legacyMethod === "plugin" || (!legacyMethod && approvalId.startsWith("plugin:"))) {
      await requestLegacyResolve("plugin.approval.resolve");
      return undefined;
    }
    try {
      await requestLegacyResolve("exec.approval.resolve");
    } catch (error) {
      if (allowPluginFallback !== true || !isApprovalNotFoundError(error)) {
        throw error;
      }
      await requestLegacyResolve("plugin.approval.resolve");
    }
    return undefined;
  };

  const scopedGatewayRuntime = getGatewayNativeApprovalRuntime();
  const result = scopedGatewayRuntime
    ? await requestWithClient({
        request: async <T>(
          method: GatewayNativeApprovalMethod,
          requestParams: Record<string, unknown>,
        ) => await scopedGatewayRuntime.request<T>(method, requestParams, { clientDisplayName }),
      })
    : await withOperatorApprovalsGatewayClient(
        {
          config: params.cfg,
          gatewayUrl: params.gatewayUrl,
          clientDisplayName,
        },
        requestWithClient,
      );
  return hasCanonicalKind ? result : undefined;
}
