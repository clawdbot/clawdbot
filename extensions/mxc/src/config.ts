import { posix, win32 } from "node:path";
import { buildPluginConfigSchema, type OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/core";
import {
  formatPluginConfigIssue,
  mapPluginConfigIssues,
} from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_SECONDS } from "openclaw/plugin-sdk/number-runtime";
import { z } from "zod";

const MXC_CONTAINMENTS = ["process", "processcontainer"] as const;
const MXC_NETWORK_MODES = ["none", "default"] as const;

type MxcContainment = (typeof MXC_CONTAINMENTS)[number];

type MxcNetworkMode = (typeof MXC_NETWORK_MODES)[number];

type MxcPluginConfig = {
  mxcBinaryPath?: string;
  containment?: MxcContainment;
  network?: MxcNetworkMode;
  timeoutSeconds?: number;
  debug?: boolean;
  mxcPolicyPaths?: string[];
};

export type MxcConfig = {
  mxcBinaryPath?: string;
  containment: MxcContainment;
  network: MxcNetworkMode;
  timeoutSeconds: number;
  timeoutSecondsConfigured?: boolean;
  debug: boolean;
  mxcPolicyPaths?: string[];
};

const DEFAULT_CONTAINMENT: MxcContainment = "process";
const DEFAULT_NETWORK: MxcNetworkMode = "none";
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_DEBUG = false;

const nonEmptyTrimmedString = (message: string) =>
  z.string({ error: message }).trim().min(1, { error: message });

const MxcPluginConfigSchema = z.strictObject({
  mxcBinaryPath: nonEmptyTrimmedString("mxcBinaryPath must be a non-empty string").optional(),
  containment: z
    .enum(MXC_CONTAINMENTS, {
      error: `containment must be one of ${MXC_CONTAINMENTS.join(", ")}`,
    })
    .optional(),
  network: z
    .enum(MXC_NETWORK_MODES, {
      error: `network must be one of ${MXC_NETWORK_MODES.join(", ")}`,
    })
    .optional(),
  timeoutSeconds: z
    .number({
      error: `timeoutSeconds must be a number between 1 and ${MAX_TIMER_TIMEOUT_SECONDS}`,
    })
    .min(1, { error: "timeoutSeconds must be a number >= 1" })
    .max(MAX_TIMER_TIMEOUT_SECONDS, {
      error: `timeoutSeconds must be a number <= ${MAX_TIMER_TIMEOUT_SECONDS}`,
    })
    .optional(),
  debug: z.boolean({ error: "debug must be a boolean" }).optional(),
  mxcPolicyPaths: z
    .array(nonEmptyTrimmedString("mxcPolicyPaths must be an array of non-empty strings"), {
      error: "mxcPolicyPaths must be an array of non-empty strings",
    })
    .optional(),
});

export function createMxcPluginConfigSchema(): OpenClawPluginConfigSchema {
  return buildPluginConfigSchema(MxcPluginConfigSchema, {
    safeParse(value) {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      const parsed = MxcPluginConfigSchema.safeParse(value);
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

export function resolveConfig(value: unknown): MxcConfig {
  if (value === undefined) {
    return {
      mxcBinaryPath: undefined,
      containment: DEFAULT_CONTAINMENT,
      network: DEFAULT_NETWORK,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      debug: DEFAULT_DEBUG,
    };
  }

  const parsed = MxcPluginConfigSchema.safeParse(value);
  if (!parsed.success) {
    const message = formatPluginConfigIssue(parsed.error.issues[0]);
    throw new Error(`Invalid mxc plugin config: ${message}`);
  }

  const config = parsed.data as MxcPluginConfig;
  const resolved: MxcConfig = {
    mxcBinaryPath: config.mxcBinaryPath,
    containment: config.containment ?? DEFAULT_CONTAINMENT,
    network: config.network ?? DEFAULT_NETWORK,
    timeoutSeconds: config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    debug: config.debug ?? DEFAULT_DEBUG,
    mxcPolicyPaths: resolveMxcPolicyPaths(config.mxcPolicyPaths),
  };

  if (config.timeoutSeconds !== undefined) {
    resolved.timeoutSecondsConfigured = true;
  }

  return resolved;
}

function resolveMxcPolicyPaths(value: string[] | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.map((entry, index) => {
    if (!isAbsolutePath(entry)) {
      throw new Error(
        `Invalid mxc plugin config: mxcPolicyPaths[${index}] must be an absolute path`,
      );
    }
    return entry;
  });
}

function isAbsolutePath(value: string): boolean {
  return win32.isAbsolute(value) || posix.isAbsolute(value);
}
