// Preserve one failed update as bounded diagnostics across the updater's fresh CLI handoff.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { resolveStateDir } from "../config/paths.js";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import { writeTextAtomic } from "../infra/json-files.js";
import {
  redactSupportString,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import { classifyUpdateOutcome } from "../shared/update-outcome.js";
import { truncateUtf8Prefix, truncateUtf8Suffix } from "../utils/utf8-truncate.js";

const UPDATE_FAILURE_MAX_BYTES = 8 * 1024;
const UPDATE_FAILURE_PROMPT_MAX_BYTES = 4 * 1024;
const updateIdentitySchema = z.object({
  sha: z.string().nullish(),
  version: z.string().nullish(),
});
const updateFailureSchema = z
  .union([
    z.object({
      result: z.object({
        status: z.enum(["ok", "error", "skipped"]),
        mode: z.enum(["git", "pnpm", "bun", "npm", "unknown"]),
        root: z.string().optional(),
        reason: z.string().optional(),
        before: updateIdentitySchema.optional(),
        after: updateIdentitySchema.optional(),
        steps: z.array(
          z.object({
            name: z.string(),
            exitCode: z.number().int().nullable(),
            stdoutTail: z.string().nullish(),
            stderrTail: z.string().nullish(),
            termination: z.enum(["exit", "timeout", "no-output-timeout", "signal"]).optional(),
            advisory: z
              .object({ kind: z.literal("package-post-install-doctor"), message: z.string() })
              .optional(),
          }),
        ),
        recovery: z
          .object({
            serviceRestartSafe: z.boolean(),
            reason: z.string().optional(),
            version: z.string().optional(),
            buildId: z.string().optional(),
            service: z.enum(["healthy", "failed"]).optional(),
          })
          .optional(),
        postUpdate: z
          .object({
            plugins: z
              .object({
                status: z.enum(["ok", "warning", "skipped", "error"]),
                reason: z.string().optional(),
                sync: z.object({ errors: z.array(z.string()) }).optional(),
                npm: z
                  .object({
                    outcomes: z.array(
                      z.object({
                        pluginId: z.string(),
                        status: z.enum(["updated", "unchanged", "skipped", "error"]),
                        message: z.string(),
                      }),
                    ),
                  })
                  .optional(),
                integrityDrifts: z
                  .array(
                    z.object({
                      pluginId: z.string(),
                      spec: z.string(),
                      expectedIntegrity: z.string(),
                      actualIntegrity: z.string(),
                    }),
                  )
                  .optional(),
                warnings: z
                  .array(
                    z.object({
                      pluginId: z.string().optional(),
                      reason: z.string(),
                      message: z.string(),
                    }),
                  )
                  .optional(),
              })
              .optional(),
          })
          .optional(),
      }),
      error: z.string().trim().min(1).optional(),
      omittedDetails: z.number().int().nonnegative().optional(),
    }),
    z
      .object({
        error: z.string().trim().min(1),
        omittedDetails: z.number().int().nonnegative().optional(),
      })
      .strict(),
  ])
  .refine(
    (failure) =>
      Boolean(failure.error) ||
      ("result" in failure && classifyUpdateOutcome(failure.result) === "failed"),
  );

/** Full UpdateRunResult values satisfy this diagnostic-only projection. */
export type TriageUpdateFailure = z.infer<typeof updateFailureSchema>;

export function sanitizeTriageUpdateFailure(
  input: unknown,
  redaction: SupportRedactionContext,
): TriageUpdateFailure {
  const parsed = updateFailureSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Invalid update failure diagnostics: expected a failed result or error.");
  }
  const failure = parsed.data;
  type Excerpt = "head" | "tail" | "ends";
  function text(value: string, maxBytes: number, excerpt?: Excerpt): string;
  function text(
    value: string | null | undefined,
    maxBytes: number,
    excerpt?: Excerpt,
  ): string | undefined;
  function text(
    value: string | null | undefined,
    maxBytes: number,
    excerpt: Excerpt = "head",
  ): string | undefined {
    if (value == null) {
      return undefined;
    }
    const redacted = redactSupportString(sanitizeForLog(value.replace(/\s+/gu, " ")), redaction, {
      maxLength: Number.MAX_SAFE_INTEGER,
    });
    if (Buffer.byteLength(JSON.stringify(redacted)) <= maxBytes) {
      return redacted;
    }
    // Reserve quotes and the omission marker; escaping also consumes the JSON field budget.
    let budget = maxBytes - 5;
    for (;;) {
      const headBytes = Math.floor(budget / 2);
      const bounded =
        excerpt === "tail"
          ? `...${truncateUtf8Suffix(redacted, budget)}`
          : excerpt === "ends"
            ? `${truncateUtf8Prefix(redacted, headBytes)}...${truncateUtf8Suffix(redacted, budget - headBytes)}`
            : `${truncateUtf8Prefix(redacted, budget)}...`;
      const bytes = Buffer.byteLength(JSON.stringify(bounded));
      if (bytes <= maxBytes) {
        return bounded;
      }
      budget = Math.floor((budget * (maxBytes - 5)) / (bytes - 5));
    }
  }
  const error = text(failure.error, 768, "ends");
  if (!("result" in failure)) {
    if (!error) {
      throw new Error("Update failure diagnostics contain no readable error.");
    }
    return { error, ...(failure.omittedDetails ? { omittedDetails: failure.omittedDetails } : {}) };
  }
  const result = failure.result;
  const identity = (value: typeof result.before) =>
    value ? { sha: text(value.sha, 48), version: text(value.version, 48) } : undefined;
  let omittedDetails = failure.omittedDetails ?? 0;
  let remainingPluginErrors = 3;
  const removePluginDetails: Array<() => void> = [];
  const takePluginErrors = <T>(
    values: T[] | undefined,
    latest = false,
    into?: T[],
  ): T[] | undefined => {
    const selected = values
      ? latest
        ? values.slice(Math.max(0, values.length - remainingPluginErrors))
        : values.slice(0, remainingPluginErrors)
      : undefined;
    remainingPluginErrors -= selected?.length ?? 0;
    omittedDetails += (values?.length ?? 0) - (selected?.length ?? 0);
    const output = into ?? selected;
    if (into && selected) {
      if (latest) {
        into.unshift(...selected);
      } else {
        into.push(...selected);
      }
    }
    for (const _ of selected ?? []) {
      removePluginDetails.push(() => {
        if (latest) {
          output?.shift();
        } else {
          output?.pop();
        }
      });
    }
    return output;
  };
  const plugins = result.postUpdate?.plugins;
  const pluginWarnings =
    plugins?.status === "error"
      ? plugins.warnings?.map((warning) => ({
          pluginId: text(warning.pluginId, 48),
          reason: text(warning.reason, 768, "ends"),
          message: text(warning.message, 64, "ends"),
        }))
      : undefined;
  // Fresh Doctor and config validation append terminal failures. Reserve the latest
  // warning before earlier errors, and retain it if whole-record pruning is needed.
  const warnings = takePluginErrors(pluginWarnings?.slice(-1));
  const postUpdate = plugins
    ? {
        plugins: {
          status: plugins.status,
          reason: text(plugins.reason, 96),
          warnings,
          sync: plugins.sync
            ? {
                errors:
                  takePluginErrors(
                    plugins.sync.errors.map((message) => text(message, 192, "ends")),
                  ) ?? [],
              }
            : undefined,
          npm: plugins.npm
            ? {
                outcomes:
                  takePluginErrors(
                    plugins.npm.outcomes
                      .filter((outcome) => outcome.status === "error")
                      .map((outcome) => ({
                        pluginId: text(outcome.pluginId, 48),
                        status: outcome.status,
                        message: text(outcome.message, 192, "ends"),
                      })),
                  ) ?? [],
              }
            : undefined,
          integrityDrifts: takePluginErrors(
            plugins.integrityDrifts?.map((drift) => ({
              pluginId: text(drift.pluginId, 48),
              spec: text(drift.spec, 64),
              expectedIntegrity: text(drift.expectedIntegrity, 64),
              actualIntegrity: text(drift.actualIntegrity, 64),
            })),
          ),
        },
      }
    : undefined;
  takePluginErrors(pluginWarnings?.slice(0, -1), true, warnings);
  const failedSteps = result.steps.filter((step) => step.exitCode !== 0 && !step.advisory);
  omittedDetails += Math.max(0, failedSteps.length - 3);
  const sanitized = {
    ...(error ? { error } : {}),
    result: {
      status: result.status,
      mode: result.mode,
      reason: text(result.reason, 128),
      postUpdate,
      root: text(result.root, 96),
      before: identity(result.before),
      after: identity(result.after),
      recovery: result.recovery
        ? {
            serviceRestartSafe: result.recovery.serviceRestartSafe,
            reason: text(result.recovery.reason, 96),
            ...(result.recovery.serviceRestartSafe
              ? {
                  version: text(result.recovery.version, 48),
                  buildId: text(result.recovery.buildId, 96),
                  service: result.recovery.service,
                }
              : {}),
          }
        : undefined,
      // Successful steps are not the failure. Keep the latest failures in execution order.
      steps: failedSteps.slice(-3).map((step) => ({
        name: text(step.name, 64),
        exitCode: step.exitCode,
        termination: step.termination,
        stderrTail: text(step.stderrTail, 160, "tail"),
        stdoutTail: text(step.stdoutTail, 160, "tail"),
      })),
    },
    omittedDetails,
  };
  // Fit whole records, retaining the latest failed step and at least one plugin cause.
  // Field caps reserve room for these plus identity and restart safety even after JSON escaping.
  while (Buffer.byteLength(JSON.stringify(sanitized)) > UPDATE_FAILURE_PROMPT_MAX_BYTES) {
    if (sanitized.result.steps.length > 1) {
      sanitized.result.steps.shift();
    } else if (removePluginDetails.length > 1) {
      removePluginDetails.pop()?.();
    } else {
      throw new Error("Update failure diagnostics exceed the 4 KiB prompt limit.");
    }
    sanitized.omittedDetails += 1;
  }
  return sanitized;
}

export async function writeTriageUpdateFailure(
  failure: TriageUpdateFailure,
  options: { env?: NodeJS.ProcessEnv; outputPath?: string } = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const sanitized = sanitizeTriageUpdateFailure(failure, { env, stateDir });
  const body = `${JSON.stringify(sanitized)}\n`;
  const outputPath =
    options.outputPath ??
    path.join(stateDir, "logs", "support", `openclaw-update-failure-${randomUUID()}.json`);
  // The managed helper's private handoff keeps the latest complete outcome after cleanup.
  await writeTextAtomic(outputPath, body, { mode: 0o600, dirMode: 0o700 });
  return outputPath;
}

export async function readTriageUpdateFailure(
  inputPath: string,
  redaction: SupportRedactionContext,
): Promise<TriageUpdateFailure> {
  const file = await fs.open(inputPath, "r");
  try {
    if (!(await file.stat()).isFile()) {
      throw new Error("Update failure diagnostics must be a regular file.");
    }
    const raw = await readFileDescriptorBounded(file.fd, UPDATE_FAILURE_MAX_BYTES);
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      throw new Error("Invalid update failure diagnostics JSON.");
    }
    return sanitizeTriageUpdateFailure(input, redaction);
  } finally {
    await file.close();
  }
}
