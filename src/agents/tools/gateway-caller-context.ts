// Ambient trusted caller context for model-mediated Gateway tool calls.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { CronCreatorAuthorityGrant } from "../../gateway/cron-creator-authority-grant.js";
import type {
  GatewayContextResolver,
  GatewayRequestContext,
} from "../../gateway/server-methods/types.js";
import type { WorkerSessionTurnClaim } from "../../gateway/worker-environments/placement-record.js";
import type { WorkerTurnExecutionIdentityCapability } from "../../gateway/worker-environments/placement-turn-claim-events.js";
import { getGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
  type OperationalRunInstanceRef,
} from "../admitted-run-context.js";
import { copyAgentToolMetadata } from "../agent-tool-metadata.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "../runtime/internal-hooks.js";
import type { AnyAgentTool } from "./common.js";

type GatewayToolCallerIdentity = {
  agentId: string;
  sessionKey: string;
  operationalRunInstance?: OperationalRunInstanceRef;
  /** Exact host-resolved owner of this individual approval request. */
  approvalOwnerPluginId?: string;
  /** Opaque already-signed identity used only by isolated worker transports. */
  signedAgentRuntimeIdentityToken?: string;
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
  /** Synchronous host-owned fence for before-tool decision receipts. */
  receiptAuthority?: () => boolean | void;
  /** Exact Gateway-owned worker claim; never sourced from model or RPC arguments. */
  workerTurnClaim?: WorkerSessionTurnClaim;
  /** Closure-bound Gateway capability; revalidates both owners at child admission. */
  workerTurnExecutionIdentityCapability?: WorkerTurnExecutionIdentityCapability;
  /** Instance-bound routing only; delegated authority is revalidated separately. */
  gatewayContextResolver?: GatewayContextResolver;
  /** Host-signed capability for the scheduled run's existing self-management surface. */
  cronSelfManagementJobId?: string;
  cronToolsAllowCapture?: "final-executable-surface";
  /** One-shot Gateway-owned proof for a freshly resolved configured-MCP cap. */
  cronCreatorAuthorityGrant?: CronCreatorAuthorityGrant;
  // Trusted run context, carried separately from model-authored tool arguments.
  turnSourceChannel?: string;
  turnSourceLocal?: true;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

type GatewayToolCallerSource = {
  agentSessionKey?: string;
  agentChannel?: string;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  agentTo?: string;
  agentAccountId?: string;
  currentThreadTs?: string;
  agentThreadId?: string | number;
};

const gatewayToolCallerStorage = new AsyncLocalStorage<GatewayToolCallerIdentity>();

// Freeze the admitted instance: a later resolver result is a replacement,
// which retires this caller's routing authority instead of transferring it.
function bindGatewayToolContextResolver(
  resolveGatewayContext: GatewayContextResolver | undefined,
): GatewayContextResolver | undefined {
  if (!resolveGatewayContext) {
    return undefined;
  }
  let admittedContext: GatewayRequestContext | undefined;
  try {
    admittedContext = resolveGatewayContext();
  } catch {
    return () => undefined;
  }
  if (!admittedContext) {
    return () => undefined;
  }
  return () => {
    try {
      return resolveGatewayContext() === admittedContext ? admittedContext : undefined;
    } catch {
      return undefined;
    }
  };
}

type AdmittedGatewayToolCallerParams = {
  admittedRunContext: AdmittedRunContext;
  receiptAuthority?: () => boolean | void;
  agentId?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceLocal?: true;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

function composeReceiptAuthority(
  ...predicates: Array<(() => boolean | void) | undefined>
): (() => boolean) | undefined {
  const checks = predicates.filter(
    (predicate, index): predicate is () => boolean | void =>
      predicate !== undefined && predicates.indexOf(predicate) === index,
  );
  return checks.length === 0
    ? undefined
    : () => {
        let active = true;
        for (const check of checks) {
          try {
            active = check() !== false && active;
          } catch {
            active = false;
          }
        }
        return active;
      };
}

/** Builds host-owned Gateway authority from the exact admitted execution. */
export function createAdmittedGatewayToolCallerIdentity(
  params: AdmittedGatewayToolCallerParams,
): GatewayToolCallerIdentity | undefined {
  const agentId = params.agentId?.trim();
  const sessionKey = params.sessionKey?.trim();
  if (!agentId || !sessionKey) {
    return undefined;
  }
  const delegatedAuthority = getAdmittedRunDelegatedAuthority(params.admittedRunContext);
  return {
    agentId,
    sessionKey,
    operationalRunInstance: params.admittedRunContext.operationalRunInstance,
    executionIdentityToken: params.admittedRunContext.executionIdentityToken,
    gatewayContextResolver: bindGatewayToolContextResolver(
      getGatewayContextResolver(params.admittedRunContext),
    ),
    receiptAuthority: composeReceiptAuthority(
      () =>
        delegatedAuthority !== undefined &&
        getAdmittedRunDelegatedAuthority(params.admittedRunContext) === delegatedAuthority,
      params.receiptAuthority,
    ),
    turnSourceChannel: params.turnSourceChannel,
    turnSourceLocal: params.turnSourceLocal,
    turnSourceTo: params.turnSourceTo,
    turnSourceAccountId: params.turnSourceAccountId,
    turnSourceThreadId: params.turnSourceThreadId,
  };
}

export function getGatewayToolCallerIdentity(): GatewayToolCallerIdentity | undefined {
  return gatewayToolCallerStorage.getStore();
}

/** Process-owned work must not retain the turn that authorized its launch. */
export function withoutGatewayToolCallerIdentity<T>(run: () => T): T {
  return gatewayToolCallerStorage.exit(run);
}

export async function withGatewayToolCallerIdentity<T>(
  identity: GatewayToolCallerIdentity | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  if (!identity?.agentId?.trim() || !identity.sessionKey?.trim()) {
    return await run();
  }
  const inherited = gatewayToolCallerStorage.getStore();
  const suppliedRun = identity.operationalRunInstance;
  const inheritedRun = inherited?.operationalRunInstance;
  // Wrappers without a run inherit the admitted owner. A distinct admitted run
  // starts a new root; retaining the outer run would let child work outlive its owner.
  const inheritedOwner =
    !suppliedRun ||
    (inheritedRun?.instanceId === suppliedRun.instanceId &&
      inheritedRun.runId === suppliedRun.runId)
      ? inherited
      : undefined;
  const operationalRunInstance =
    inheritedOwner?.operationalRunInstance ?? identity.operationalRunInstance;
  const signedAgentRuntimeIdentityToken =
    inheritedOwner?.signedAgentRuntimeIdentityToken ??
    identity.signedAgentRuntimeIdentityToken?.trim();
  const executionIdentityToken =
    inheritedOwner?.executionIdentityToken ?? identity.executionIdentityToken;
  const receiptAuthority = composeReceiptAuthority(
    inheritedOwner?.receiptAuthority,
    identity.receiptAuthority,
  );
  const workerTurnClaim = inheritedOwner?.workerTurnClaim ?? identity.workerTurnClaim;
  const workerTurnExecutionIdentityCapability =
    inheritedOwner?.workerTurnExecutionIdentityCapability ??
    identity.workerTurnExecutionIdentityCapability;
  const gatewayContextResolver =
    inheritedOwner?.gatewayContextResolver ??
    bindGatewayToolContextResolver(identity.gatewayContextResolver);
  const cronSelfManagementJobId =
    identity.cronSelfManagementJobId?.trim() ?? inheritedOwner?.cronSelfManagementJobId;
  const cronToolsAllowCapture =
    identity.cronToolsAllowCapture ?? inheritedOwner?.cronToolsAllowCapture;
  const cronCreatorAuthorityGrant =
    identity.cronCreatorAuthorityGrant ?? inheritedOwner?.cronCreatorAuthorityGrant;
  const turnSourceChannel = inheritedOwner?.turnSourceChannel ?? identity.turnSourceChannel?.trim();
  const turnSourceLocal = inheritedOwner?.turnSourceLocal ?? identity.turnSourceLocal;
  const turnSourceTo = inheritedOwner?.turnSourceTo ?? identity.turnSourceTo?.trim();
  const turnSourceAccountId =
    inheritedOwner?.turnSourceAccountId ?? identity.turnSourceAccountId?.trim();
  const turnSourceThreadId = inheritedOwner?.turnSourceThreadId ?? identity.turnSourceThreadId;
  return await gatewayToolCallerStorage.run(
    {
      agentId: inheritedOwner?.agentId ?? identity.agentId.trim(),
      sessionKey: inheritedOwner?.sessionKey ?? identity.sessionKey.trim(),
      ...(operationalRunInstance ? { operationalRunInstance } : {}),
      ...(identity.approvalOwnerPluginId?.trim()
        ? { approvalOwnerPluginId: identity.approvalOwnerPluginId.trim() }
        : inheritedOwner?.approvalOwnerPluginId
          ? { approvalOwnerPluginId: inheritedOwner.approvalOwnerPluginId }
          : {}),
      ...(signedAgentRuntimeIdentityToken ? { signedAgentRuntimeIdentityToken } : {}),
      ...(cronSelfManagementJobId ? { cronSelfManagementJobId } : {}),
      ...(cronToolsAllowCapture ? { cronToolsAllowCapture } : {}),
      ...(cronCreatorAuthorityGrant ? { cronCreatorAuthorityGrant } : {}),
      ...(executionIdentityToken ? { executionIdentityToken } : {}),
      ...(receiptAuthority ? { receiptAuthority } : {}),
      ...(workerTurnClaim ? { workerTurnClaim } : {}),
      ...(workerTurnExecutionIdentityCapability ? { workerTurnExecutionIdentityCapability } : {}),
      ...(gatewayContextResolver ? { gatewayContextResolver } : {}),
      ...(turnSourceChannel ? { turnSourceChannel } : {}),
      ...(turnSourceLocal === true ? { turnSourceLocal: true } : {}),
      ...(turnSourceTo ? { turnSourceTo } : {}),
      ...(turnSourceAccountId ? { turnSourceAccountId } : {}),
      ...(turnSourceThreadId !== undefined ? { turnSourceThreadId } : {}),
    },
    run,
  );
}

/** Narrows one host-owned approval call to the exact registered policy/harness owner. */
export async function withGatewayToolApprovalOwner<T>(
  pluginId: string | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  const identity = gatewayToolCallerStorage.getStore();
  const approvalOwnerPluginId = pluginId?.trim();
  if (!identity || !approvalOwnerPluginId) {
    return await run();
  }
  return await withGatewayToolCallerIdentity({ ...identity, approvalOwnerPluginId }, run);
}

export function wrapToolWithGatewayCallerIdentity(
  tool: AnyAgentTool,
  identity: GatewayToolCallerIdentity | undefined,
): AnyAgentTool {
  if (!identity?.agentId?.trim() || !identity.sessionKey?.trim() || !tool.execute) {
    return tool;
  }
  const wrapped: AnyAgentTool = {
    ...tool,
    execute: async (...args) =>
      await withGatewayToolCallerIdentity(identity, async () => await tool.execute?.(...args)),
  };
  copyAgentToolMetadata(tool, wrapped);
  const sourcePreparer = getInternalToolExecutionPreparer(tool);
  if (sourcePreparer) {
    attachInternalToolExecutionPreparer(wrapped, async (params) => {
      const prepared = await withGatewayToolCallerIdentity(identity, () => sourcePreparer(params));
      return prepared.kind === "ready"
        ? {
            ...prepared,
            execute: (start) =>
              withGatewayToolCallerIdentity(identity, () => prepared.execute(start)),
          }
        : prepared;
    });
  }
  return wrapped;
}

export function createGatewayToolCallerWrapper(
  agentId: string | undefined,
  source: GatewayToolCallerSource | undefined,
): (tool: AnyAgentTool) => AnyAgentTool {
  const identity =
    agentId && source?.agentSessionKey?.trim()
      ? {
          agentId,
          sessionKey: source.agentSessionKey.trim(),
          turnSourceChannel: source.agentChannel,
          turnSourceTo: source.currentMessagingTarget ?? source.currentChannelId ?? source.agentTo,
          turnSourceAccountId: source.agentAccountId,
          turnSourceThreadId: source.currentThreadTs ?? source.agentThreadId,
        }
      : undefined;
  return (tool) => wrapToolWithGatewayCallerIdentity(tool, identity);
}
