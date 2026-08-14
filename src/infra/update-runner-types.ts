import type { CommandOptions } from "../process/exec.js";
import type { OpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import type { PackageUpdateStepAdvisory } from "./package-update-steps.js";
import type { UpdateChannel } from "./update-channels.js";
import type { DevUpdateTarget } from "./update-dev-target.js";
import type { GlobalInstallManager } from "./update-global.js";

export type UpdateStepAdvisory = PackageUpdateStepAdvisory;

export type UpdateStepResult = {
  name: string;
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
  advisory?: UpdateStepAdvisory;
};

export type UpdateRunResult = {
  status: "ok" | "error" | "skipped";
  mode: "git" | "pnpm" | "bun" | "npm" | "unknown";
  root?: string;
  reason?: string;
  before?: { sha?: string | null; version?: string | null };
  after?: { sha?: string | null; version?: string | null; upstreamRef?: string };
  steps: UpdateStepResult[];
  durationMs: number;
  recovery?:
    | { serviceRestartSafe: true }
    | {
        serviceRestartSafe: false;
        reason:
          | "source-rollback-failed"
          | "manager-unavailable"
          | "deps-install-failed"
          | "build-failed"
          | "runtime-verification-failed";
      };
  postUpdate?: {
    plugins?: {
      status: "ok" | "warning" | "skipped" | "error";
      reason?: string;
      changed: boolean;
      warnings?: Array<{
        pluginId?: string;
        reason: string;
        message: string;
        guidance: string[];
      }>;
      sync: {
        changed: boolean;
        switchedToBundled: string[];
        switchedToNpm: string[];
        warnings: string[];
        errors: string[];
      };
      npm: {
        changed: boolean;
        outcomes: Array<{
          pluginId: string;
          status: "updated" | "unchanged" | "skipped" | "error";
          message: string;
          currentVersion?: string;
          nextVersion?: string;
          channelFallback?: {
            requestedSpec: string;
            usedSpec: string;
            requestedLabel: string;
            usedLabel: string;
            reason: "unavailable" | "failed";
            message: string;
          };
        }>;
      };
      integrityDrifts: Array<{
        pluginId: string;
        spec: string;
        expectedIntegrity: string;
        actualIntegrity: string;
        resolvedSpec?: string;
        resolvedVersion?: string;
        action: "aborted";
      }>;
    };
  };
};

export type CommandRunner = (
  argv: string[],
  options: CommandOptions,
) => Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
}>;

export type UpdateStepInfo = {
  name: string;
  command: string;
  index: number;
  total: number;
};

type UpdateStepCompletion = UpdateStepInfo & {
  durationMs: number;
  exitCode: number | null;
  stderrTail?: string | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
  advisory?: UpdateStepAdvisory;
};

export type UpdateStepProgress = {
  onStepStart?: (step: UpdateStepInfo) => void;
  onStepComplete?: (step: UpdateStepCompletion) => void;
};

export type UpdateRunnerOptions = {
  cwd?: string;
  argv1?: string;
  tag?: string;
  channel?: UpdateChannel;
  devTarget?: DevUpdateTarget;
  deferConfiguredPluginInstallRepair?: boolean;
  allowGatewayServiceRepair?: boolean;
  allowGatewayActivation?: boolean;
  beforeGitMutation?: (target: {
    schemaVersions?: OpenClawSchemaVersions;
    metadataUnreadable?: string;
  }) => Promise<{
    allowGatewayServiceRepair?: boolean;
    allowGatewayActivation?: boolean;
  } | void>;
  timeoutMs?: number;
  runCommand?: CommandRunner;
  progress?: UpdateStepProgress;
};

export type UpdateInstallSurface =
  | { kind: "git"; mode: "git"; root: string; packageRoot: string }
  | { kind: "global"; mode: GlobalInstallManager; root: string; packageRoot: string }
  | { kind: "package-root"; mode: "unknown"; root: string; packageRoot: string }
  | { kind: "missing"; mode: "unknown"; root?: string; packageRoot?: undefined };

export type RunStepOptions = {
  runCommand: CommandRunner;
  name: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  progress?: UpdateStepProgress;
  stepIndex: number;
  totalSteps: number;
  results?: UpdateStepResult[];
};
