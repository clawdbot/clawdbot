import type { ExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import type { ExecApprovalDecision, ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { AgentRuntimeDelegatedAuthority } from "./agent-runtime-identity-token.js";
import type {
  PlacementStandingGrantMintSpec,
  PlacementStandingGrantRuntime,
} from "./operator-approval-placement-grants.js";
import type { CronStandingGrantMintSpec } from "./operator-approval-standing-grants.js";
import type {
  ForceDenyOperatorApprovalResult,
  OperatorApprovalKind,
  OperatorApprovalRecord,
  OperatorApprovalResolver,
  OperatorApprovalStatus,
  OperatorApprovalTerminalReason,
  ResolveOperatorApprovalResult,
} from "./operator-approval-store.js";

// Node replay distinguishes a trusted auto-review verdict from an operator decision.
export type ExecApprovalResolutionSource = "operator" | "auto-review";

export type ExecApprovalRecord<TPayload = ExecApprovalRequestPayload> = {
  id: string;
  request: TPayload;
  createdAtMs: number;
  expiresAtMs: number;
  // Requester bindings prevent another client from replaying an approval id.
  requestedByConnId?: string | null;
  requestedByDeviceId?: string | null;
  requestedByClientId?: string | null;
  requestedByDeviceTokenAuth?: boolean;
  approvalReviewerDeviceIds?: string[];
  resolvedAtMs?: number;
  decision?: ExecApprovalDecision;
  consumedDecision?: ExecApprovalDecision;
  resolutionSource?: ExecApprovalResolutionSource;
  askFallbackConsumed?: boolean;
  resolvedBy?: string | null;
  status?: OperatorApprovalStatus;
  terminalReason?: OperatorApprovalTerminalReason | null;
  runtimeEpoch?: string;
  resolverKind?: OperatorApprovalResolver["kind"] | null;
  consumedAtMs?: number | null;
  consumedBy?: string | null;
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
  /** Exact source authority retained only for use-time liveness validation. */
  agentRuntimeDelegatedAuthority?: AgentRuntimeDelegatedAuthority;
  /** Closure-bound authority for approvals created by in-process delegated tools. */
  approvalAuthority?: () => boolean | void;
  approvalSignals?: readonly AbortSignal[];
  /** Process-local persistence proof; never serialized with approval presentation. */
  mcpToolApprovalActive?: () => boolean;
};

export type OperatorApprovalLifecycleEvent = {
  phase: "pending" | "terminal";
  record: OperatorApprovalRecord;
};

export type OperatorStandingGrantMintSpec =
  | ({ kind: "cron" } & CronStandingGrantMintSpec)
  | { kind: "mcp-tool"; agentId: string; server: string; tool: string }
  | ({ kind: "placement" } & PlacementStandingGrantMintSpec);

export type ExecApprovalManagerOptions<TPayload> = {
  approvalKind?: OperatorApprovalKind;
  persistence: {
    runtimeEpoch: string;
    databaseOptions?: OpenClawStateDatabaseOptions;
  };
  resolveAllowedDecisions?: (request: TPayload) => readonly ExecApprovalDecision[];
  /** Gateway owns lineage lookup; absence seeds only the requesting session. */
  resolveAudienceSessionKeys?: (
    sourceSessionKey: string,
    sourceAgentId?: string | null,
  ) => string[];
  onError?: (
    error: Error,
    context: { approvalId: string; approvalKind: OperatorApprovalKind; operation: "expire" },
  ) => void;
  onLifecycle?: (event: OperatorApprovalLifecycleEvent) => void;
  /** Eligible allow-always requests derive one scoped grant, or return null. */
  resolveStandingGrantMint?: (request: TPayload) => OperatorStandingGrantMintSpec | null;
  /** Installs a placement grant after the durable approval CAS succeeds. */
  retainPlacementStandingGrant?: PlacementStandingGrantRuntime["retain"];
  resolveStandingGrantExpiresAtMs?: (nowMs: number) => number | null;
  /** Timer, lookup, and replay expiry must all release the same local waiter. */
  onExpired?: (record: OperatorApprovalRecord, liveRecord: ExecApprovalRecord<TPayload>) => void;
  validateAgentRuntimeDelegatedAuthority?: (authority: AgentRuntimeDelegatedAuthority) => boolean;
};

type WithLiveRecord<TResult, TPayload> = TResult extends { record: OperatorApprovalRecord }
  ? TResult & { liveRecord?: ExecApprovalRecord<TPayload> }
  : TResult;

export type ExecApprovalResolveResult<TPayload = ExecApprovalRequestPayload> = WithLiveRecord<
  ResolveOperatorApprovalResult,
  TPayload
>;

export type ExecApprovalForceDenyResult<TPayload = ExecApprovalRequestPayload> = WithLiveRecord<
  ForceDenyOperatorApprovalResult,
  TPayload
>;

export type ExecApprovalDurableLookup =
  | { outcome: "found"; record: OperatorApprovalRecord }
  | { outcome: "missing" | "corrupt"; id: string };

export type ExecApprovalIdLookupResult =
  | { kind: "exact" | "prefix"; id: string }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "none" };
