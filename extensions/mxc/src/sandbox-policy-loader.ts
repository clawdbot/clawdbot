import { readFileSync, statSync } from "node:fs";
import { win32 } from "node:path";
import { z } from "zod";
import {
  DEFAULT_SANDBOX_BASELINE,
  resolveSandboxBaseline,
  type BaselineFilesystemPolicyInput,
  type SandboxBaselinePolicy,
  type SandboxBaselinePolicyInput,
} from "./sandbox-baseline.js";

type SandboxPolicyLoaderOptions = {
  policyPaths?: readonly string[];
};

type SandboxPolicyPathField =
  | "filesystem.additionalReadonlyPaths"
  | "filesystem.additionalReadwritePaths";

export type SandboxConfiguredPathEntry = {
  path: string;
  sources: readonly string[];
};

type SandboxConfiguredPaths = {
  readonlyPaths: readonly SandboxConfiguredPathEntry[];
  readwritePaths: readonly SandboxConfiguredPathEntry[];
};

type SandboxPolicyLayer = SandboxBaselinePolicyInput & {
  configuredPaths: SandboxConfiguredPaths;
};

export type LoadedSandboxBaselinePolicy = SandboxBaselinePolicy & {
  configuredPaths: SandboxConfiguredPaths;
};

type SandboxPolicySource = {
  label: string;
  policy: SandboxPolicyLayer;
};

type MutableConfiguredPathMaps = {
  readonlyPaths: Map<string, SandboxConfiguredPathEntry>;
  readwritePaths: Map<string, SandboxConfiguredPathEntry>;
};

const stringArraySchema = z.array(z.string());
const hardeningBooleanSchema = z.literal(true);
const filesystemPolicySchema = z
  .object({
    restrictToProjectDir: hardeningBooleanSchema.optional(),
    additionalReadonlyPaths: stringArraySchema.optional(),
    additionalReadwritePaths: stringArraySchema.optional(),
  })
  .strict();
const processPolicySchema = z
  .object({
    timeoutSeconds: z.number().finite().min(1).optional(),
  })
  .strict();

const SandboxPolicyLayerSchema = z
  .object({
    filesystem: filesystemPolicySchema.optional(),
    process: processPolicySchema.optional(),
  })
  .strict();

export function loadSandboxBaselinePolicy(
  options: SandboxPolicyLoaderOptions = {},
): LoadedSandboxBaselinePolicy {
  const sources: SandboxPolicySource[] = [];

  for (const policyPath of options.policyPaths ?? []) {
    sources.push({ label: policyPath, policy: readSandboxPolicyFile(policyPath) });
  }

  const merged = mergeSandboxPolicyLayers(sources);
  const resolved = resolveSandboxBaseline(merged);
  return {
    ...resolved,
    process: {
      ...resolved.process,
      timeoutSecondsConfigured: sources.some(
        ({ policy }) => policy.process?.timeoutSeconds !== undefined,
      ),
    },
    configuredPaths: merged.configuredPaths,
  };
}

function readSandboxPolicyFile(policyPath: string): SandboxPolicyLayer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(policyPath, "utf-8"));
  } catch (err) {
    throw policyFileError(policyPath, err);
  }

  try {
    return parseSandboxPolicyLayer(parsed, policyPath);
  } catch (err) {
    throw policyFileError(policyPath, err);
  }
}

function parseSandboxPolicyLayer(value: unknown, sourceLabel: string): SandboxPolicyLayer {
  const parsed = SandboxPolicyLayerSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(formatSandboxPolicyIssue(sourceLabel, parsed.error.issues[0]));
  }

  const filesystem = parsed.data.filesystem;
  const readonlyPaths = normalizeConfiguredPaths(
    filesystem?.additionalReadonlyPaths,
    sourceLabel,
    "filesystem.additionalReadonlyPaths",
  );
  const readwritePaths = normalizeConfiguredPaths(
    filesystem?.additionalReadwritePaths,
    sourceLabel,
    "filesystem.additionalReadwritePaths",
  );

  return {
    ...parsed.data,
    filesystem: filesystem
      ? {
          ...filesystem,
          ...(readonlyPaths.length > 0
            ? {
                additionalReadonlyPaths: readonlyPaths.map((entry) => entry.path),
              }
            : {}),
          ...(readwritePaths.length > 0
            ? {
                additionalReadwritePaths: readwritePaths.map((entry) => entry.path),
              }
            : {}),
        }
      : undefined,
    configuredPaths: {
      readonlyPaths,
      readwritePaths,
    },
  };
}

function mergeSandboxPolicyLayers(sources: readonly SandboxPolicySource[]): SandboxPolicyLayer {
  const timeoutCandidates = [DEFAULT_SANDBOX_BASELINE.process.timeoutSeconds];
  const filesystem: BaselineFilesystemPolicyInput = {
    restrictToProjectDir: DEFAULT_SANDBOX_BASELINE.filesystem.restrictToProjectDir,
    additionalReadonlyPaths: [],
    additionalReadwritePaths: [],
  };
  const configuredPathMaps: MutableConfiguredPathMaps = {
    readonlyPaths: new Map<string, SandboxConfiguredPathEntry>(),
    readwritePaths: new Map<string, SandboxConfiguredPathEntry>(),
  };

  for (const { policy, label } of sources) {
    mergeFilesystemPolicy(filesystem, policy.filesystem);
    mergeConfiguredPathEntries(
      configuredPathMaps.readonlyPaths,
      policy.configuredPaths.readonlyPaths,
    );
    mergeConfiguredPathEntries(
      configuredPathMaps.readwritePaths,
      policy.configuredPaths.readwritePaths,
    );
    const timeoutSeconds = policy.process?.timeoutSeconds;
    if (timeoutSeconds !== undefined) {
      assertPositiveFiniteNumber(timeoutSeconds, `${label}.process.timeoutSeconds`);
      timeoutCandidates.push(timeoutSeconds);
    }
  }

  return {
    filesystem: {
      ...filesystem,
      additionalReadonlyPaths: [...configuredPathMaps.readonlyPaths.values()].map(
        (entry) => entry.path,
      ),
      additionalReadwritePaths: [...configuredPathMaps.readwritePaths.values()].map(
        (entry) => entry.path,
      ),
    },
    process: {
      timeoutSeconds: Math.min(...timeoutCandidates),
    },
    configuredPaths: {
      readonlyPaths: [...configuredPathMaps.readonlyPaths.values()],
      readwritePaths: [...configuredPathMaps.readwritePaths.values()],
    },
  };
}

function mergeFilesystemPolicy(
  target: BaselineFilesystemPolicyInput | undefined,
  layer: BaselineFilesystemPolicyInput | undefined,
): void {
  if (!target || !layer) {
    return;
  }

  target.restrictToProjectDir = mostRestrictiveBoolean(
    DEFAULT_SANDBOX_BASELINE.filesystem.restrictToProjectDir,
    target.restrictToProjectDir,
    layer.restrictToProjectDir,
  );
}

function mergeConfiguredPathEntries(
  target: Map<string, SandboxConfiguredPathEntry>,
  entries: readonly SandboxConfiguredPathEntry[],
): void {
  for (const entry of entries) {
    const existing = target.get(entry.path);
    if (!existing) {
      target.set(entry.path, entry);
      continue;
    }
    target.set(entry.path, {
      path: entry.path,
      sources: [...new Set([...existing.sources, ...entry.sources])],
    });
  }
}

function normalizeConfiguredPaths(
  values: readonly string[] | undefined,
  sourceLabel: string,
  field: SandboxPolicyPathField,
): SandboxConfiguredPathEntry[] {
  if (!values || values.length === 0) {
    return [];
  }

  const deduped = new Map<string, SandboxConfiguredPathEntry>();
  for (const [index, value] of values.entries()) {
    const source = `${sourceLabel}.${field}[${index}]`;
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new TypeError(`Sandbox policy field ${source} must not be blank.`);
    }
    if (!win32.isAbsolute(trimmed)) {
      throw new TypeError(`Sandbox policy field ${source} must be an absolute Windows path.`);
    }

    const normalized = win32.normalize(trimmed);
    assertConfiguredPathExists(normalized, source);

    const existing = deduped.get(normalized);
    if (!existing) {
      deduped.set(normalized, { path: normalized, sources: [source] });
      continue;
    }
    deduped.set(normalized, {
      path: normalized,
      sources: [...new Set([...existing.sources, source])],
    });
  }

  return [...deduped.values()];
}

function assertConfiguredPathExists(pathValue: string, source: string): void {
  try {
    statSync(pathValue);
  } catch (err) {
    if (isNodeError(err)) {
      if (err.code === "ENOENT") {
        throw new Error(
          `Sandbox policy path ${pathValue} configured by ${source} does not exist on the host. ` +
            `Create the path or update the policy file.`,
          { cause: err },
        );
      }
      throw new Error(
        `Sandbox policy path ${pathValue} configured by ${source} is not accessible on the host: ${formatError(err)}`,
        { cause: err },
      );
    }
    throw err;
  }
}

function mostRestrictiveBoolean(
  defaultValue: boolean,
  ...values: readonly (boolean | undefined)[]
): boolean {
  return defaultValue || values.some((value) => value === true);
}

function assertPositiveFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new TypeError(`Sandbox policy field ${label} must be a positive number.`);
  }
}

function policyFileError(policyPath: string, err: unknown): Error {
  if (isNodeError(err) && err.code === "ENOENT") {
    return new Error(
      `Configured sandbox policy file ${policyPath} does not exist. Remove it from mxcPolicyPaths or create the file.`,
      { cause: err },
    );
  }
  return new Error(`Failed to load sandbox policy file at ${policyPath}: ${formatError(err)}`, {
    cause: err instanceof Error ? err : undefined,
  });
}

function formatSandboxPolicyIssue(sourceLabel: string, issue: z.ZodIssue | undefined): string {
  if (!issue) {
    return `Sandbox policy at ${sourceLabel} is invalid.`;
  }
  if (issue.path.length === 0 && issue.code === "invalid_type") {
    return `Sandbox policy at ${sourceLabel} must be a JSON object.`;
  }

  const fieldLabel = `${sourceLabel}${formatIssuePath(issue.path)}`;
  if (issue.code === "unrecognized_keys" && issue.keys.length > 0) {
    return `Sandbox policy field ${fieldLabel}.${issue.keys[0]} is not supported.`;
  }
  if (issue.code === "invalid_type" && issue.path.length === 1) {
    return `Sandbox policy section ${fieldLabel} must be a JSON object.`;
  }
  if (issue.code === "invalid_type") {
    return `Sandbox policy field ${fieldLabel} ${issue.message}.`;
  }
  if (issue.code === "too_small") {
    return `Sandbox policy field ${fieldLabel} must be a positive number.`;
  }
  return `Sandbox policy field ${fieldLabel} ${issue.message}.`;
}

function formatIssuePath(pathSegments: readonly PropertyKey[]): string {
  let label = "";
  for (const segment of pathSegments) {
    if (typeof segment === "number") {
      label += `[${segment}]`;
      continue;
    }
    label += `.${String(segment)}`;
  }
  return label;
}

function formatError(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
