import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z.strictObject({
  version: z.literal(1),
  taskDigest: digestSchema,
  sourceRevision: z
    .string()
    .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
    .nullable(),
  checkProfileDigest: digestSchema,
  runProfileDigest: digestSchema,
  requiredScenarios: z.array(z.string().min(1)).min(1),
  harness: z.string().min(1),
});

export type QaRunComparisonIdentity = z.infer<typeof identitySchema>;

function contentDigest(value: unknown): string {
  // Sort object keys, but preserve array order: scenario and action order affect execution.
  const bytes = JSON.stringify(value, (_key, entry: unknown) => {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return entry;
  });
  return createHash("sha256").update(bytes).digest("hex");
}

function cleanCheckoutRevision(repoRoot: string): string | null {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    }).trim();
  try {
    const before = git(["rev-parse", "--verify", "HEAD"]);
    const dirty = git(["status", "--porcelain", "--untracked-files=normal"]);
    const after = git(["rev-parse", "--verify", "HEAD"]);
    return !dirty && before === after ? before : null;
  } catch {
    // Unknown source is not equality, and workflow environment variables are not source proof.
    return null;
  }
}

export function captureQaRunComparisonIdentity(params: {
  repoRoot: string;
  scenarios: readonly QaSeedScenarioWithSource[];
  runProfile: Record<string, unknown>;
  harness: string;
}): QaRunComparisonIdentity {
  return {
    version: 1,
    taskDigest: contentDigest(params.scenarios),
    sourceRevision: cleanCheckoutRevision(params.repoRoot),
    checkProfileDigest: contentDigest(
      params.scenarios.map((scenario) => ({
        name: scenario.title,
        execution: scenario.execution,
        successCriteria: scenario.successCriteria,
      })),
    ),
    runProfileDigest: contentDigest(params.runProfile),
    requiredScenarios: params.scenarios.map((scenario) => scenario.title),
    harness: params.harness,
  };
}

export function finalizeQaRunComparisonIdentity(
  identity: QaRunComparisonIdentity,
  repoRoot: string,
): QaRunComparisonIdentity {
  return {
    ...identity,
    sourceRevision:
      cleanCheckoutRevision(repoRoot) === identity.sourceRevision ? identity.sourceRevision : null,
  };
}

const summarySchema = z.object({
  run: z.object({
    status: z.literal("completed"),
    comparisonIdentity: identitySchema,
    primaryModel: z.string().min(1),
    primaryProvider: z.string().min(1).nullable(),
    alternateModel: z.string().min(1),
    alternateProvider: z.string().min(1).nullable(),
  }),
  metrics: z.object({ wallMs: z.number().finite().nonnegative() }).optional(),
  scenarios: z
    .array(
      z.object({
        name: z.string().min(1),
        status: z.enum(["pass", "fail", "skip"]),
      }),
    )
    .min(1),
});

export function compareQaRunConditions(candidate: unknown, baseline: unknown) {
  const parsed = [summarySchema.safeParse(candidate), summarySchema.safeParse(baseline)];
  const reasons: string[] = [];
  for (const [index, result] of parsed.entries()) {
    if (!result.success) {
      reasons.push(
        `${index === 0 ? "Candidate" : "Baseline"} lacks valid completed-run comparison metadata.`,
      );
    }
  }
  const left = parsed[0];
  const right = parsed[1];
  if (!left?.success || !right?.success) {
    return { status: "not-comparable" as const, reasons };
  }
  for (const key of [
    "taskDigest",
    "sourceRevision",
    "checkProfileDigest",
    "runProfileDigest",
  ] as const) {
    const a = left.data.run.comparisonIdentity[key];
    const b = right.data.run.comparisonIdentity[key];
    if (a === null || b === null || a !== b) {
      reasons.push(`${key} is missing or different.`);
    }
  }
  const candidateChecks = new Map(left.data.scenarios.map(({ name, status }) => [name, status]));
  const baselineChecks = new Map(right.data.scenarios.map(({ name, status }) => [name, status]));
  for (const [role, summary, observed] of [
    ["Candidate", left.data, candidateChecks],
    ["Baseline", right.data, baselineChecks],
  ] as const) {
    const required = summary.run.comparisonIdentity.requiredScenarios;
    if (
      new Set(required).size !== required.length ||
      observed.size !== summary.scenarios.length ||
      required.length !== observed.size ||
      required.some((name) => !observed.has(name))
    ) {
      reasons.push(`${role} required scenario coverage is incomplete or duplicated.`);
    }
  }
  const required = left.data.run.comparisonIdentity.requiredScenarios;
  if (
    JSON.stringify(required) !== JSON.stringify(right.data.run.comparisonIdentity.requiredScenarios)
  ) {
    reasons.push("Required scenario identities differ.");
  }
  if (reasons.length > 0) {
    return { status: "not-comparable" as const, reasons };
  }
  const describe = (summary: z.infer<typeof summarySchema>) => ({
    harness: summary.run.comparisonIdentity.harness,
    primaryModel: summary.run.primaryModel,
    primaryProvider: summary.run.primaryProvider,
    alternateModel: summary.run.alternateModel,
    alternateProvider: summary.run.alternateProvider,
    elapsedMs: summary.metrics?.wallMs ?? null,
  });
  const checks = required.map((name) => ({
    name,
    candidate: candidateChecks.get(name)!,
    baseline: baselineChecks.get(name)!,
  }));
  return {
    status: "comparable" as const,
    reasons,
    candidate: describe(left.data),
    baseline: describe(right.data),
    checks,
    regressions: checks
      .filter((check) => check.baseline === "pass" && check.candidate !== "pass")
      .map((check) => check.name),
  };
}
