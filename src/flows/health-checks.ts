// Health check types define doctor checks, results, and repair metadata.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";

// Public doctor health contracts shared by core checks, plugin checks, lint, and repair.
export type HealthFindingSeverity = "info" | "warning" | "error";

export const HEALTH_FINDING_SEVERITY_RANK: Record<HealthFindingSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

/** Parses CLI/config severity input into the closed health-finding severity set. */
export function parseHealthFindingSeverity(
  input: string | undefined,
): HealthFindingSeverity | null {
  if (input === "info" || input === "warning" || input === "error") {
    return input;
  }
  return null;
}

/** Returns whether a finding meets the configured reporting threshold. */
export function healthFindingMeetsSeverity(
  finding: Pick<HealthFinding, "severity">,
  severityMin: HealthFindingSeverity,
): boolean {
  return (
    HEALTH_FINDING_SEVERITY_RANK[finding.severity] >= HEALTH_FINDING_SEVERITY_RANK[severityMin]
  );
}

/** Structured finding emitted by doctor health checks. */
export interface HealthFinding {
  readonly checkId: string;
  readonly severity: HealthFindingSeverity;
  readonly message: string;
  readonly source?: string;
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
  readonly ocPath?: string;
  readonly target?: string;
  readonly requirement?: string;
  readonly fixHint?: string;
}

type HealthCheckMode = "doctor" | "lint" | "fix";

/** Immutable runtime/config context passed to health check detection. */
export interface HealthCheckContext {
  readonly mode: HealthCheckMode;
  readonly runtime: RuntimeEnv;
  readonly cfg: OpenClawConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly configPath?: string;
  readonly allowExecSecretRefs?: boolean;
}

/** Repair-capable health-check context; fixes may emit diffs or dry-run previews. */
export interface HealthRepairContext extends Omit<HealthCheckContext, "mode"> {
  readonly mode: "fix";
  readonly dryRun?: boolean;
  readonly diff?: boolean;
}

/** Optional before/after detail for config or file repair output. */
export interface HealthRepairDiff {
  readonly kind: "config" | "file";
  readonly path: string;
  readonly before?: string;
  readonly after?: string;
  readonly unifiedDiff?: string;
}

/** Side effect descriptor for repairs that touch services, processes, packages, or state. */
export interface HealthRepairEffect {
  readonly kind: "config" | "file" | "service" | "process" | "package" | "state" | "other";
  readonly action: string;
  readonly target?: string;
  readonly dryRunSafe?: boolean;
}

/** Repair result returned by split health-check repair functions. */
export interface HealthRepairResult {
  readonly status?: "repaired" | "skipped" | "failed";
  readonly reason?: string;
  readonly config?: OpenClawConfig;
  readonly changes: readonly string[];
  readonly warnings?: readonly string[];
  readonly diffs?: readonly HealthRepairDiff[];
  readonly effects?: readonly HealthRepairEffect[];
}

/** Narrow validation scope built from previous findings after a repair runs. */
export interface HealthCheckScope {
  readonly findings?: readonly HealthFinding[];
  readonly paths?: readonly string[];
  readonly ocPaths?: readonly string[];
}

/** Split detect/repair health-check contract registered by core or plugins. */
export interface HealthCheck {
  readonly id: string;
  readonly kind: "core" | "plugin";
  readonly description: string;
  readonly source?: string;
  detect(ctx: HealthCheckContext, scope?: HealthCheckScope): Promise<readonly HealthFinding[]>;
  repair?(
    ctx: HealthRepairContext,
    findings: readonly HealthFinding[],
  ): Promise<HealthRepairResult>;
}
