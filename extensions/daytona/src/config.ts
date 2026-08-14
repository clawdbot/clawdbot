// Daytona sandbox plugin config schema and resolution.
import path from "node:path";
import { buildPluginConfigSchema, type OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/core";
import {
  formatPluginConfigIssue,
  mapPluginConfigIssues,
} from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_SECONDS } from "openclaw/plugin-sdk/number-runtime";
import { buildOptionalSecretInputSchema, type SecretInput } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

type DaytonaSandboxResources = {
  cpu?: number;
  gpu?: number;
  memory?: number;
  disk?: number;
};

type DaytonaVolumeMount = {
  volumeId: string;
  mountPath: string;
};

export type ResolvedDaytonaPluginConfig = {
  apiKey?: SecretInput;
  apiUrl?: string;
  target?: string;
  snapshot?: string;
  image?: string;
  resources?: DaytonaSandboxResources;
  user?: string;
  volumes?: DaytonaVolumeMount[];
  autoStopInterval?: number;
  autoPauseInterval?: number;
  autoArchiveInterval?: number;
  autoDeleteInterval?: number;
  networkBlockAll: boolean;
  networkAllowList?: string;
  domainAllowList?: string;
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
  timeoutMs: number;
};

const DEFAULT_REMOTE_WORKSPACE_DIR = "/home/daytona/workspace";
const DEFAULT_REMOTE_AGENT_WORKSPACE_DIR = "/home/daytona/agent";
const DEFAULT_TIMEOUT_MS = 120_000;

const nonEmptyTrimmedString = (message: string) =>
  z.string({ error: message }).trim().min(1, { error: message });

const optionalMinutesInterval = (field: string) =>
  z
    .int({ error: `${field} must be an integer number of minutes >= 0` })
    .min(0, { error: `${field} must be an integer number of minutes >= 0` })
    .optional();

const optionalResourceUnits = (field: string) =>
  z
    .int({ error: `${field} must be an integer >= 1` })
    .min(1, { error: `${field} must be an integer >= 1` })
    .optional();

const DaytonaPluginConfigSchema = z.strictObject({
  apiKey: buildOptionalSecretInputSchema(),
  apiUrl: nonEmptyTrimmedString("apiUrl must be a non-empty string").optional(),
  target: nonEmptyTrimmedString("target must be a non-empty string").optional(),
  snapshot: nonEmptyTrimmedString("snapshot must be a non-empty string").optional(),
  image: nonEmptyTrimmedString("image must be a non-empty string").optional(),
  resources: z
    .strictObject({
      cpu: optionalResourceUnits("resources.cpu"),
      gpu: optionalResourceUnits("resources.gpu"),
      memory: optionalResourceUnits("resources.memory"),
      disk: optionalResourceUnits("resources.disk"),
    })
    .optional(),
  user: nonEmptyTrimmedString("user must be a non-empty string").optional(),
  volumes: z
    .array(
      z.strictObject({
        volumeId: nonEmptyTrimmedString("volumes[].volumeId must be a non-empty string"),
        mountPath: nonEmptyTrimmedString("volumes[].mountPath must be a non-empty string"),
      }),
      { error: "volumes must be an array of { volumeId, mountPath } objects" },
    )
    .optional(),
  autoStopInterval: optionalMinutesInterval("autoStopInterval"),
  autoPauseInterval: optionalMinutesInterval("autoPauseInterval"),
  autoArchiveInterval: optionalMinutesInterval("autoArchiveInterval"),
  autoDeleteInterval: optionalMinutesInterval("autoDeleteInterval"),
  networkBlockAll: z.boolean({ error: "networkBlockAll must be a boolean" }).optional(),
  networkAllowList: nonEmptyTrimmedString("networkAllowList must be a non-empty string").optional(),
  domainAllowList: nonEmptyTrimmedString("domainAllowList must be a non-empty string").optional(),
  remoteWorkspaceDir: nonEmptyTrimmedString(
    "remoteWorkspaceDir must be a non-empty string",
  ).optional(),
  remoteAgentWorkspaceDir: nonEmptyTrimmedString(
    "remoteAgentWorkspaceDir must be a non-empty string",
  ).optional(),
  timeoutSeconds: z
    .number({
      error: `timeoutSeconds must be a number between 1 and ${MAX_TIMER_TIMEOUT_SECONDS}`,
    })
    .min(1, { error: "timeoutSeconds must be a number >= 1" })
    .max(MAX_TIMER_TIMEOUT_SECONDS, {
      error: `timeoutSeconds must be a number <= ${MAX_TIMER_TIMEOUT_SECONDS}`,
    })
    .optional(),
});

function normalizeDaytonaRemotePath(
  value: string | undefined,
  fallback: string,
  fieldName: string,
): string {
  const candidate = value ?? fallback;
  const normalized = path.posix.normalize(candidate.trim() || fallback);
  if (!normalized.startsWith("/")) {
    throw new Error(`Daytona ${fieldName} must be an absolute POSIX path: ${candidate}`);
  }
  const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
  if (trimmed === "/") {
    throw new Error(`Daytona ${fieldName} must not be the filesystem root: ${candidate}`);
  }
  return trimmed;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function createDaytonaPluginConfigSchema(): OpenClawPluginConfigSchema {
  return buildPluginConfigSchema(DaytonaPluginConfigSchema, {
    safeParse(value) {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      const parsed = DaytonaPluginConfigSchema.safeParse(value);
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }
      return {
        success: false,
        error: {
          issues: mapPluginConfigIssues(parsed.error.issues),
        },
      };
    },
  });
}

export function resolveDaytonaPluginConfig(value: unknown): ResolvedDaytonaPluginConfig {
  if (value === undefined) {
    return {
      networkBlockAll: true,
      remoteWorkspaceDir: DEFAULT_REMOTE_WORKSPACE_DIR,
      remoteAgentWorkspaceDir: DEFAULT_REMOTE_AGENT_WORKSPACE_DIR,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  }

  const parsed = DaytonaPluginConfigSchema.safeParse(value);
  if (!parsed.success) {
    const message = formatPluginConfigIssue(parsed.error.issues[0]);
    throw new Error(`Invalid daytona plugin config: ${message}`);
  }
  const cfg = parsed.data;
  if (cfg.snapshot && cfg.image) {
    throw new Error(
      "Daytona snapshot and image are mutually exclusive; configure one base per sandbox.",
    );
  }
  if (cfg.resources && !cfg.image) {
    // Daytona applies explicit resources only to image-based creates; snapshot
    // sandboxes inherit the resources baked into the snapshot.
    throw new Error("Daytona resources require image; snapshot sandboxes size from the snapshot.");
  }
  if (cfg.autoStopInterval && cfg.autoPauseInterval) {
    // Daytona API contract: at most one of the two intervals may be non-zero.
    throw new Error(
      "Daytona autoStopInterval and autoPauseInterval cannot both be non-zero; pick one idle policy.",
    );
  }
  const remoteWorkspaceDir = normalizeDaytonaRemotePath(
    cfg.remoteWorkspaceDir,
    DEFAULT_REMOTE_WORKSPACE_DIR,
    "remoteWorkspaceDir",
  );
  const remoteAgentWorkspaceDir = normalizeDaytonaRemotePath(
    cfg.remoteAgentWorkspaceDir,
    DEFAULT_REMOTE_AGENT_WORKSPACE_DIR,
    "remoteAgentWorkspaceDir",
  );
  // Distinct roots keep workspace/agent mount resolution unambiguous in the
  // shared remote fs bridge; nested roots would shadow each other.
  if (pathsOverlap(remoteWorkspaceDir, remoteAgentWorkspaceDir)) {
    throw new Error(
      `Daytona remoteWorkspaceDir and remoteAgentWorkspaceDir must be distinct, non-nested paths: ${remoteWorkspaceDir}, ${remoteAgentWorkspaceDir}`,
    );
  }
  const volumes = cfg.volumes?.map((volume, index) => {
    const mountPath = normalizeDaytonaRemotePath(
      volume.mountPath,
      volume.mountPath,
      `volumes[${index}].mountPath`,
    );
    // Volumes mounted over the managed workspace roots would fight seeding and
    // the fs bridge mount table.
    if (
      pathsOverlap(mountPath, remoteWorkspaceDir) ||
      pathsOverlap(mountPath, remoteAgentWorkspaceDir)
    ) {
      throw new Error(
        `Daytona volumes[${index}].mountPath must not overlap the managed workspace dirs: ${mountPath}`,
      );
    }
    return { volumeId: volume.volumeId, mountPath };
  });
  if (volumes) {
    for (let index = 1; index < volumes.length; index += 1) {
      const mountPath = volumes[index]?.mountPath ?? "";
      const conflict = volumes
        .slice(0, index)
        .find((earlier) => pathsOverlap(earlier.mountPath, mountPath));
      if (conflict) {
        throw new Error(
          `Daytona volumes mount paths must not overlap each other: ${conflict.mountPath}, ${mountPath}`,
        );
      }
    }
  }
  return {
    apiKey: cfg.apiKey,
    apiUrl: cfg.apiUrl,
    target: cfg.target,
    snapshot: cfg.snapshot,
    image: cfg.image,
    resources: cfg.resources,
    user: cfg.user,
    volumes,
    autoStopInterval: cfg.autoStopInterval,
    autoPauseInterval: cfg.autoPauseInterval,
    autoArchiveInterval: cfg.autoArchiveInterval,
    autoDeleteInterval: cfg.autoDeleteInterval,
    // Egress is denied by default, matching the Docker backend's no-network
    // stance. Configured allow lists are Daytona's selective-egress mode, so
    // they imply explicit egress instead of being silently disabled by an
    // implied blockAll (verified live: blockAll blocks allow-listed hosts too).
    networkBlockAll: cfg.networkBlockAll ?? !(cfg.networkAllowList || cfg.domainAllowList),
    networkAllowList: cfg.networkAllowList,
    domainAllowList: cfg.domainAllowList,
    remoteWorkspaceDir,
    remoteAgentWorkspaceDir,
    timeoutMs:
      typeof cfg.timeoutSeconds === "number"
        ? Math.floor(cfg.timeoutSeconds * 1000)
        : DEFAULT_TIMEOUT_MS,
  };
}
