// Sbx helper module supports config behavior.
import { buildPluginConfigSchema, type OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/core";
import {
  formatPluginConfigIssue,
  mapPluginConfigIssues,
} from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_SECONDS } from "openclaw/plugin-sdk/number-runtime";
import { z } from "zod";

type SbxPluginConfig = {
  command?: string;
  agent?: string;
  template?: string;
  pull?: "always" | "missing" | "never";
  timeoutSeconds?: number;
};

export type ResolvedSbxPluginConfig = {
  command: string;
  agent: string;
  template?: string;
  pull: "always" | "missing" | "never";
  timeoutMs: number;
};

const DEFAULT_COMMAND = "sbx";
const DEFAULT_AGENT = "shell";
const DEFAULT_PULL = "missing";
const DEFAULT_TIMEOUT_MS = 120_000;

const nonEmptyTrimmedString = (message: string) =>
  z.string({ error: message }).trim().min(1, { error: message });

const SbxPluginConfigSchema = z.strictObject({
  command: nonEmptyTrimmedString("command must be a non-empty string").optional(),
  agent: nonEmptyTrimmedString("agent must be a non-empty string").optional(),
  template: nonEmptyTrimmedString("template must be a non-empty string").optional(),
  pull: z
    .enum(["always", "missing", "never"], {
      error: "pull must be one of always, missing, never",
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
});

export function createSbxPluginConfigSchema(): OpenClawPluginConfigSchema {
  return buildPluginConfigSchema(SbxPluginConfigSchema, {
    safeParse(value) {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      const parsed = SbxPluginConfigSchema.safeParse(value);
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

export function resolveSbxPluginConfig(value: unknown): ResolvedSbxPluginConfig {
  if (value === undefined) {
    return {
      command: DEFAULT_COMMAND,
      agent: DEFAULT_AGENT,
      template: undefined,
      pull: DEFAULT_PULL,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  }

  const parsed = SbxPluginConfigSchema.safeParse(value);
  if (!parsed.success) {
    const message = formatPluginConfigIssue(parsed.error.issues[0]);
    throw new Error(`Invalid sbx plugin config: ${message}`);
  }
  const cfg = parsed.data as SbxPluginConfig;
  return {
    command: cfg.command ?? DEFAULT_COMMAND,
    agent: cfg.agent ?? DEFAULT_AGENT,
    template: cfg.template,
    pull: cfg.pull ?? DEFAULT_PULL,
    timeoutMs:
      typeof cfg.timeoutSeconds === "number"
        ? Math.floor(cfg.timeoutSeconds * 1000)
        : DEFAULT_TIMEOUT_MS,
  };
}
