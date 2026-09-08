import { createHash } from "node:crypto";
import { z } from "zod";

export const telegramQaScenario = "telegram-markdown-parser-fidelity" as const;
const botApiMethods = new Set([
  "getMe",
  "getUpdates",
  "getWebhookInfo",
  "deleteWebhook",
  "setMyCommands",
  "deleteMyCommands",
  "getMyCommands",
  "sendMessage",
  "sendChatAction",
]);
export function isTelegramQaBotApiRequest(httpMethod: string | undefined, method: string): boolean {
  return (
    botApiMethods.has(method) &&
    (httpMethod === "POST" ||
      (httpMethod === "GET" && (method === "getMe" || method === "getWebhookInfo")))
  );
}
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[1-9][0-9]{0,19}$/);
const text = z.string().max(4096);
export const telegramQaExecutionSchema = z.strictObject({
  schema: z.literal("mantis.telegram-qa-execution.v1"),
  request_id: digest,
  candidate_sha: sha,
  harness_sha: sha,
  run_id: id,
  run_attempt: z.literal(1),
  scenario: z.literal(telegramQaScenario),
  transport: z.literal("Crabline"),
  live_service: z.literal(false),
  candidate_quiescent: z.literal(true),
});
export const telegramQaResultSchema = z
  .strictObject({
    schema: z.literal("mantis.telegram-qa-result.v1"),
    scenario: z.literal(telegramQaScenario),
    status: z.enum(["pass", "fail"]),
    steps: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(240),
          status: z.enum(["pass", "fail"]),
        }),
      )
      .min(1)
      .max(8),
  })
  .refine(
    (value) =>
      (value.steps.every((step) => step.status === "pass") ? "pass" : "fail") === value.status,
    "QA result and step status disagree",
  );
const caseId = z.enum([
  "all-space-code",
  "unclosed-link-label",
  "ipv6-link",
  "table-code-leading-space",
]);
export const telegramQaObservationsSchema = z
  .strictObject({
    schema: z.literal("mantis.telegram-qa-observations.v1"),
    scenario: z.literal(telegramQaScenario),
    cases: z
      .array(
        z.strictObject({
          case: caseId,
          messageId: id,
          expectedHtml: text,
          outboundHtml: text,
          acceptedPayloads: z
            .array(z.strictObject({ text, parseMode: z.string().max(32).nullable() }))
            .min(1)
            .max(8),
        }),
      )
      .length(4),
  })
  .refine(
    (value) => new Set(value.cases.map((item) => item.case)).size === 4,
    "Incomplete or duplicate QA case inventory",
  );

export function verifyTelegramQaFiles(
  identity: {
    request_id: string;
    candidate_sha: string;
    harness: { sha: string };
    run: { id: string; attempt: number };
  },
  encodedFiles: unknown,
) {
  const encoded = z
    .strictObject({
      "qa-execution.json": z.string(),
      "qa-result.json": z.string(),
      "qa-observations.json": z.string(),
    })
    .parse(encodedFiles);
  const files = Object.fromEntries(
    Object.entries(encoded).map(([name, value]) => {
      if (value.length > 90_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
        throw new Error("Invalid QA evidence encoding");
      }
      const bytes = Buffer.from(value, "base64");
      if (bytes.length > 65536) {
        throw new Error("Oversized QA evidence");
      }
      return [name, bytes];
    }),
  );
  const execution = telegramQaExecutionSchema.parse(
    JSON.parse(files["qa-execution.json"]!.toString()),
  );
  if (
    execution.request_id !== identity.request_id ||
    execution.candidate_sha !== identity.candidate_sha ||
    execution.harness_sha !== identity.harness.sha ||
    execution.run_id !== identity.run.id ||
    execution.run_attempt !== identity.run.attempt
  ) {
    throw new Error("QA execution identity mismatch");
  }
  const result = telegramQaResultSchema.parse(JSON.parse(files["qa-result.json"]!.toString()));
  const observed = telegramQaObservationsSchema.parse(
    JSON.parse(files["qa-observations.json"]!.toString()),
  );
  // The trusted canonical YAML runner owns assertion semantics. This layer checks
  // complete provenance and carries its result; it does not create another judge.
  return {
    assertion_outcome: result.status,
    observations: [
      {
        id: "qa-execution",
        expected: "Exact candidate Gateway; isolated Crabline transport; no live service",
        actual: "Trusted controller confirmed candidate stopped before publication",
        source_path: "qa-execution.json",
      },
      {
        id: "qa-result",
        expected: "Canonical telegram-markdown-parser-fidelity assertions pass",
        actual: `Canonical QA result: ${result.status}; ${result.steps.length} completed steps`,
        source_path: "qa-result.json",
      },
      {
        id: "qa-observations",
        expected: "Four canonical formatting cases observed at the Bot API boundary",
        actual: `${observed.cases.length} complete case observations; inspect linked evidence for exact HTML payloads`,
        source_path: "qa-observations.json",
      },
    ].map((observation) => ({
      id: observation.id,
      expected: observation.expected,
      actual: observation.actual,
      source_path: observation.source_path,
      sha256: createHash("sha256").update(files[observation.source_path]!).digest("hex"),
      authority: "trusted_observer" as const,
      availability: "present" as const,
    })),
  };
}
