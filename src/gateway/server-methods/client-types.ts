import type { ConnectParams } from "../../../packages/gateway-protocol/src/schema/frames.js";
import type { RuntimeContextFragment } from "../../agents/internal-runtime-context.js";
import type { TranscriptSenderIdentity } from "../../chat/sender-identity.js";
import type { PluginSubagentRequesterContext } from "../../plugins/runtime/subagent-requester-context.js";
import type { RuntimePluginToolGrant } from "../../plugins/runtime/tool-grant.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { AuthenticatedGitHubIdentitySync } from "../github-user-identity.js";
import type { GatewayOperatorRoleActor } from "../operator-role-actor.js";
import type { PluginNodeCapabilitySurface } from "../plugin-node-capability.js";
import type { TrustedSessionCreation } from "./session-creation-provenance.js";

/** Trusted in-process spawn control plane that already owns this run's task row.
    Gateway CLI tracking only covers runs nobody else records, so a marked run
    must never get a second row. */
export type GatewayAgentRunTaskOwner = "plugin_subagent" | "native_subagent";

/** Caller identity captured by a built-in agent tool before trusted in-process dispatch. */
export type TrustedAgentToolCaller = Readonly<{
  agentId: string;
  sessionKey: string;
}>;

/** Closure-bound streaming hooks attached only to trusted plugin-owned synthetic clients. */
export type GatewayNodeInvokeStream = {
  onProgress: (chunk: string) => void;
  onDispatchReady: (invokeId: string) => void;
  idleTimeoutMs?: number;
  isRuntimeCurrent: () => boolean;
};

/** Per-connection client metadata captured after the gateway handshake. */
export type GatewayClient = {
  connect: ConnectParams;
  /** Transport-owned revocation marker; retained callers have no authority after invalidation. */
  invalidated?: boolean;
  /** Host-owned transport retirement notification; does not cancel ordinary admitted RPCs. */
  connectionSignal?: AbortSignal;
  connId?: string;
  presenceKey?: string;
  clientIp?: string;
  /** Client id verified against the server-approved device pairing record. */
  pairedClientId?: string;
  authenticatedUserId?: string;
  /** Verified Tailscale provider identity; generic proxy identities must not infer this. */
  authenticatedUserIsTailscaleProvider?: boolean;
  authenticatedGitHubIdentitySync?: AuthenticatedGitHubIdentitySync;
  authenticatedUserProfile?: {
    profileId: string;
    displayName: string | null;
    avatarRevision?: string;
    hasAvatar: boolean;
    updatedAt: number;
  };
  pluginSurfaceUrls?: Record<string, string>;
  pluginNodeCapabilitySurfaces?: Record<string, PluginNodeCapabilitySurface>;
  pluginNodeCapabilities?: Record<string, { capability: string; expiresAtMs: number }>;
  isDeviceTokenAuth?: boolean;
  internal?: {
    /** Handshake-attested direct-local transport; never accepted from wire params. */
    isLocalClient?: true;
    /** Authenticated Control UI admin admission; never accepted from wire params. */
    controlUiAdmin?: true;
    /** Marks the server-constructed client used by trusted in-process dispatch. */
    syntheticClient?: true;
    /** Host-owned role authority retained separately from an autonomous run principal. */
    operatorRoleActor?: GatewayOperatorRoleActor;
    /** Overrides persisted sender attribution without changing the authorizing client identity. */
    senderAttribution?: { id: string; name?: string; identity?: TranscriptSenderIdentity };
    /** Trusted session creation provenance; never accepted from Gateway wire params. */
    sessionCreation?: TrustedSessionCreation;
    /** Trusted built-in agent tool caller; never accepted from Gateway wire params. */
    agentToolCaller?: TrustedAgentToolCaller;
    allowModelOverride?: boolean;
    approvalRuntime?: boolean;
    cronRunContinuation?: boolean;
    agentRuntimeIdentity?: AgentRuntimeIdentity;
    pluginRuntimeOwnerId?: string;
    /** Host-attested session provenance for a trusted official plugin node invocation. */
    nodeInvokeApprovalSessionKey?: string;
    /** Plugin-owned in-process invoke hooks; never accepted from Gateway wire params. */
    nodeInvokeStream?: GatewayNodeInvokeStream;
    agentRunTracking?: GatewayAgentRunTaskOwner;
    /** Host-captured requester lineage for opt-in plugin subagent completion delivery. */
    pluginSubagentRequester?: PluginSubagentRequesterContext;
    /** Host-owned exact media set for a scoped automatic recovery delivery. */
    internalDeliveryMediaUrls?: string[];
    runtimeContextFragments?: RuntimeContextFragment[];
    internalDeliverySuppressText?: boolean;
    /** Plugin-owned tools authorized for this internal subagent run. */
    runtimePluginToolGrant?: RuntimePluginToolGrant;
    /** Host-owned exact tool cap for a tracked plugin subagent run. */
    pluginSubagentToolsAllow?: string[];
    /** Opaque in-process subagent-completion capability; never accepted from wire params. */
    delegatedToolPolicyHandoffId?: string;
  };
};
