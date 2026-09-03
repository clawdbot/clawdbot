/** Shared daemon service argument, state, and command config contracts. */
import type { GatewayServiceRuntime } from "./service-runtime.js";

/** Environment map passed to service renderers and platform supervisors. */
export type GatewayServiceEnv = Record<string, string | undefined>;

/** Arguments required to render/install a managed gateway service. */
export type GatewayServiceInstallArgs = {
  env: GatewayServiceEnv;
  stdout: NodeJS.WritableStream;
  warn?: (message: string) => void;
  programArguments: string[];
  workingDirectory?: string;
  environment?: GatewayServiceEnv;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
  description?: string;
  // Verified before a config rewrite; Windows uses this to bridge a transient
  // listener gap while replacing a Startup-folder fallback.
  startupFallbackTakeoverRuntime?: GatewayServiceRuntime;
};

export type GatewayServiceStageArgs = GatewayServiceInstallArgs;

export type GatewayServiceManageArgs = {
  env: GatewayServiceEnv;
  stdout: NodeJS.WritableStream;
};

export type GatewayServiceControlArgs = {
  stdout: NodeJS.WritableStream;
  env?: GatewayServiceEnv;
  disable?: boolean;
  preserveDefinition?: boolean;
  warn?: (message: string) => void;
  onMutation?: (mutation: GatewayLifecycleMutation) => void;
};

export type GatewayLifecycleMutationMode =
  | "enable"
  | "bootstrap"
  | "kickstart"
  | "bootout"
  | "disable"
  | "disable-stop"
  | "disable-bootout"
  | "handoff-kickstart"
  | "handoff-reload"
  | "systemctl-start"
  | "systemctl-stop"
  | "systemctl-restart"
  | "startup-entry-start"
  | "startup-entry-stop"
  | "startup-entry-restart"
  | "schtasks-start"
  | "schtasks-stop"
  | "schtasks-end"
  | "schtasks-restart"
  | "sigterm"
  | "sigusr1"
  | "rpc"
  | "launchd-bootstrap"
  | "service-repair"
  | "scheduled"
  | "deferred"
  | "coalesced"
  | "reload"
  | "start-after-exit";

export type GatewayLifecycleMutation = {
  mode: GatewayLifecycleMutationMode;
};

export type GatewayServiceRestartResult = { outcome: "completed" } | { outcome: "scheduled" };

export type GatewayServiceEnvArgs = {
  env?: GatewayServiceEnv;
  // Bounds service-manager probes (e.g. `systemctl`) so a wedged daemon socket
  // cannot hang status reads indefinitely. Only status read paths set this;
  // control/install paths leave it unset to preserve their existing behavior.
  timeoutMs?: number;
};

/** Options for read-only service inspection that should fail soft under a deadline. */
export type GatewayServiceReadOptions = {
  timeoutMs?: number;
  requireEffective?: boolean;
};

export type GatewayServiceEnvironmentValueSource = "inline" | "file" | "inline-and-file";

export type GatewayServiceLoadState =
  | { status: "loaded" }
  | { status: "not-loaded" }
  | { status: "unknown"; detail: string };

const SERVICE_DEFINITION_ARTIFACTS = {
  "service-directory":
    "service directory (~/.config/systemd/user) or its nearest existing ancestor",
  "state-directory": "service state directory or its nearest existing ancestor",
  "definition-directory": "loaded service definition directory",
  "service-file": "service file",
} as const;

const SERVICE_DEFINITION_REASONS = {
  "unsafe-permissions":
    "is group/world-writable. Inspect ownership and permissions locally. If the path is yours and not intentionally shared, remove group/other write access with chmod go-w <path>, then retry. Use 0700 for private directories; ask the deployment owner about shared paths. Do not use recursive chmod or sudo to bypass this check.",
  "invalid-artifact":
    "has an unexpected file type. Inspect the service directories and files locally; have their owner repair the layout before retrying. Changing permissions alone will not repair it.",
  symlink:
    "is a symbolic link. Ask the deployment owner to replace the managed file through the deployment process; OpenClaw will not rewrite the link or its target.",
  "foreign-owner":
    "belongs to another account. Ask the privileged deployment owner to repair or replace it; do not take ownership or use --force to bypass this check.",
  "sealed-mount":
    "cannot be replaced on its mount. Ask the deployment owner to update the mounted artifact or deployment; chmod and --force cannot make it replaceable.",
  "system-owned":
    "is owned by a system service. Ask the privileged deployment owner to update it; do not create a competing user service.",
  "system-ownership-unverified":
    "has unverifiable system-service ownership. Restore system service-manager and filesystem inspection access from the service account, then retry; do not create a competing user service.",
  "inspection-failed":
    "cannot be safely inspected. Inspect service definition access and native service-manager availability from the service account, then retry. Do not share config or environment contents.",
} as const;

export type ServiceDefinitionMutationArtifact = keyof typeof SERVICE_DEFINITION_ARTIFACTS;
export type ServiceDefinitionMutationCapability =
  | { kind: "writable" }
  | {
      kind: "sealed" | "unknown";
      reason: keyof typeof SERVICE_DEFINITION_REASONS;
      artifact?: ServiceDefinitionMutationArtifact;
    };

export function assertServiceDefinitionWritable(capability: ServiceDefinitionMutationCapability) {
  if (capability.kind === "writable") {
    return;
  }
  // Only allowlisted facts reach callers: paths, native errors, and extra fields can contain secrets.
  const reason = Object.hasOwn(SERVICE_DEFINITION_REASONS, capability.reason)
    ? capability.reason
    : "inspection-failed";
  const artifact =
    capability.artifact && Object.hasOwn(SERVICE_DEFINITION_ARTIFACTS, capability.artifact)
      ? SERVICE_DEFINITION_ARTIFACTS[capability.artifact]
      : "service definition";
  // Update recovery recognizes these prefixes to preserve a protected definition.
  const code =
    capability.kind === "sealed" ? "SERVICE_DEFINITION_SEALED" : "SERVICE_DEFINITION_UNKNOWN";
  throw new Error(`${code}: [${reason}] The ${artifact} ${SERVICE_DEFINITION_REASONS[reason]}`);
}

export type GatewayServiceCommandSnapshot = {
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource>;
};

export type GatewayServiceManagedOverrides = {
  launcher?: "command" | "working-directory";
  environment?: true | { keys?: string[]; resetInline?: true; resetFiles?: true };
};

/** Effective platform service command and, when externally owned, its managed base definition. */
export type GatewayServiceCommandConfig = GatewayServiceCommandSnapshot & {
  sourcePath?: string;
  definitionPaths?: string[];
  managedDefinition?: GatewayServiceCommandSnapshot;
  managedOverrides?: GatewayServiceManagedOverrides;
  reloadPending?: true;
};

export function resolveManagedGatewayServiceCommand(
  command: GatewayServiceCommandConfig | null | undefined,
): GatewayServiceCommandSnapshot | null {
  return command?.managedDefinition ?? command ?? null;
}

/** Operator-owned launcher overrides cannot be repaired by rewriting the managed base. */
export function hasGatewayServiceLauncherOverride(
  command: GatewayServiceCommandConfig | null | undefined,
  options?: { includeWorkingDirectory?: boolean },
): boolean {
  const managedOverrides = command?.managedOverrides;
  const includeWorkingDirectory = options?.includeWorkingDirectory !== false;
  if (managedOverrides) {
    return Boolean(
      managedOverrides.launcher &&
      (includeWorkingDirectory || managedOverrides.launcher !== "working-directory"),
    );
  }
  const managedDefinition = command?.managedDefinition;
  return Boolean(
    managedDefinition &&
    ((includeWorkingDirectory && managedDefinition.workingDirectory !== command.workingDirectory) ||
      managedDefinition.programArguments.join("\0") !== command.programArguments.join("\0")),
  );
}

export function hasGatewayServiceEnvironmentOverride(
  command: GatewayServiceCommandConfig | null | undefined,
  keys: readonly string[],
  options?: {
    normalizeKey?: (key: string) => string | null;
    environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
    ignoreResets?: boolean;
  },
): boolean {
  const managedOverrides = command?.managedOverrides;
  if (!managedOverrides) {
    return hasGatewayServiceEnvironmentDifference(command, keys);
  }
  const environment = managedOverrides.environment;
  if (environment === true || !environment) {
    return environment === true && keys.length > 0;
  }
  const normalize = options?.normalizeKey ?? ((key: string) => key);
  const ownedKeys = new Set(environment.keys?.map(normalize));
  const sources =
    options?.environmentValueSources ?? command.managedDefinition?.environmentValueSources;
  return keys.some((key) => {
    const normalized = normalize(key);
    if (normalized !== null && ownedKeys.has(normalized)) {
      return true;
    }
    if (options?.ignoreResets) {
      return false;
    }
    const source =
      sources?.[key] ??
      (options?.normalizeKey &&
        Object.entries(sources ?? {}).find(([rawKey]) => normalize(rawKey) === normalized)?.[1]) ??
      "inline";
    return Boolean(
      (environment.resetInline && source !== "file") ||
      (environment.resetFiles && source !== "inline"),
    );
  });
}

export function hasGatewayServiceEnvironmentDifference(
  command: GatewayServiceCommandConfig | null | undefined,
  keys: readonly string[],
): boolean {
  const managedDefinition = command?.managedDefinition;
  return Boolean(
    managedDefinition &&
    keys.some(
      (key) =>
        command.environment?.[key] !== managedDefinition.environment?.[key] ||
        (command.environmentValueSources?.[key] ?? "inline") !==
          (managedDefinition.environmentValueSources?.[key] ?? "inline"),
    ),
  );
}

/** Remove inherited operator overrides before a managed definition is rewritten. */
export function resolveManagedGatewayServiceProcessEnv(
  command: GatewayServiceCommandConfig | null | undefined,
  processEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | null {
  const overrides = command?.managedOverrides?.environment;
  if (overrides === true || overrides?.resetInline || overrides?.resetFiles) {
    return null;
  }
  const managedEnvironment = resolveManagedGatewayServiceCommand(command)?.environment;
  const environment = { ...processEnv, ...managedEnvironment };
  for (const key of [...Object.keys(command?.environment ?? {}), ...(overrides?.keys ?? [])]) {
    if (!Object.hasOwn(managedEnvironment ?? {}, key)) {
      delete environment[key];
    }
  }
  return environment;
}

export type GatewayServiceState = {
  installed: boolean;
  loadState: GatewayServiceLoadState;
  running: boolean;
  env: GatewayServiceEnv;
  command: GatewayServiceCommandConfig | null;
  definitionMutationCapability?: ServiceDefinitionMutationCapability;
  runtime?: GatewayServiceRuntime;
};

export type GatewayServiceStartRepairIssue = {
  code: "missing-program" | "port-mismatch" | "temporary-program";
  message: string;
};

export type GatewayServiceStartResult =
  | {
      outcome: "already-running";
      state: GatewayServiceState;
      issues: GatewayServiceStartRepairIssue[];
    }
  | { outcome: "started"; state: GatewayServiceState }
  | { outcome: "missing-install"; state: GatewayServiceState }
  | {
      outcome: "repair-required";
      state: GatewayServiceState;
      issues: GatewayServiceStartRepairIssue[];
    };

export type GatewayServiceRenderArgs = {
  description?: string;
  programArguments: string[];
  workingDirectory?: string;
  environment?: GatewayServiceEnv;
  environmentFiles?: string[];
};
