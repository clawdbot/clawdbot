// Resolves exec and plugin approvals through the gateway client.
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalResolveParams,
  ApprovalResolveResult,
} from "../../packages/gateway-protocol/src/index.js";
import { isWellFormedApprovalId } from "../../packages/gateway-protocol/src/schema/approvals.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOperatorApprovalsGatewayClient } from "../gateway/operator-approvals-client.js";
import { isApprovalNotFoundError } from "./approval-errors.js";

type ResolveApprovalOverGatewayBaseParams = {
  cfg: OpenClawConfig;
  approvalId: string;
  decision: ApprovalDecision;
  senderId?: string | null;
  gatewayUrl?: string;
  clientDisplayName?: string;
};

type CanonicalResolveApprovalOverGatewayParams = ResolveApprovalOverGatewayBaseParams & {
  /** Explicit owner required by the canonical approval resolver. */
  approvalKind: ApprovalKind;
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
  resolveMethod?: "exec" | "plugin";
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
  if (approvalKind !== undefined) {
    if (!hasCanonicalKind || resolveMethod !== undefined || allowPluginFallback !== undefined) {
      throw new Error("canonical approval resolution requires exactly one valid owner kind");
    }
  } else if (
    (resolveMethod !== undefined && !hasLegacyMethod) ||
    (allowPluginFallback !== undefined && typeof allowPluginFallback !== "boolean")
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

  const result = await withOperatorApprovalsGatewayClient(
    {
      config: params.cfg,
      gatewayUrl: params.gatewayUrl,
      clientDisplayName:
        params.clientDisplayName ?? `Approval (${params.senderId?.trim() || "unknown"})`,
    },
    async (gatewayClient) => {
      if (hasCanonicalKind) {
        const resolveParams: ApprovalResolveParams = {
          id: approvalId,
          kind: canonicalKind,
          decision: params.decision,
        };
        return await gatewayClient.request<ApprovalResolveResult>(
          "approval.resolve",
          resolveParams,
        );
      }

      const requestLegacyResolve = async (
        method: "exec.approval.resolve" | "plugin.approval.resolve",
      ): Promise<void> => {
        await gatewayClient.request(method, {
          id: approvalId,
          decision: params.decision,
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
    },
  );
  return hasCanonicalKind ? result : undefined;
}
