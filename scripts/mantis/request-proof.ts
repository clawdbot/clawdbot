import { createHash } from "node:crypto";
import { z } from "zod";
import { telegramQaScenario, verifyTelegramQaFiles } from "./telegram-qa-proof.ts";
import { telegramProofIdentitySchema, verifyTelegramProofFiles } from "./telegram-request-proof.ts";

export const requestProofDefinitions = {
  "web-ui-chat-proof": {
    workflow: ".github/workflows/mantis-web-ui-chat-proof.yml",
    runName: "Mantis request",
    job: "Run request-bound web chat proof",
    artifact: "mantis-request-web-ui",
    archive: "evidence",
  },
  "telegram-bot-e2e-proof": {
    workflow: ".github/workflows/mantis-telegram-bot-e2e-proof.yml",
    runName: "Mantis Telegram request",
    job: "Run request-bound Telegram bot proof",
    artifact: "mantis-request-telegram",
    archive: "telegram-evidence",
  },
  [telegramQaScenario]: {
    workflow: ".github/workflows/mantis-telegram-bot-e2e-proof.yml",
    runName: "Mantis Telegram request",
    job: "Run request-bound Telegram bot proof",
    artifact: "mantis-request-telegram",
    archive: "telegram-qa-evidence",
  },
} as const;

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const numericId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const bounded = z.string().min(1).max(2048);
const sourcePath = z
  .string()
  .max(240)
  .regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/);
export const requestIdentitySchema = z
  .strictObject({
    request_id: digest,
    plan_sha256: digest.optional(),
    repository: z.strictObject({
      id: numericId,
      full_name: z.literal("openclaw/openclaw"),
    }),
    pull_request: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    candidate_sha: sha,
    scenario: z.enum(["web-ui-chat-proof", "telegram-bot-e2e-proof", telegramQaScenario]),
    workflow: z.strictObject({
      path: z.enum([
        ".github/workflows/mantis-web-ui-chat-proof.yml",
        ".github/workflows/mantis-telegram-bot-e2e-proof.yml",
      ]),
      sha,
    }),
    harness: z.strictObject({ sha }),
    run: z.strictObject({ id: numericId, attempt: z.literal(1) }),
  })
  .refine(
    (value) =>
      value.workflow.path === requestProofDefinitions[value.scenario].workflow &&
      value.workflow.sha === value.harness.sha,
    "Scenario/workflow mismatch",
  );
const evidenceSchema = z.strictObject({
  artifact_id: numericId,
  artifact_name: z.string().min(1).max(200),
  sha256: digest,
});
const executionSchema = z.enum(["completed", "failed", "cancelled", "timed_out", "skipped"]);
const observationSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  expected: bounded,
  actual: bounded,
  source_path: sourcePath,
  sha256: digest,
  availability: z.enum(["present", "missing", "partial"]),
  authority: z.enum(["trusted_observer", "candidate_reported"]),
});
export const requestReceiptSchema = requestIdentitySchema
  .safeExtend({
    schema: z.literal("mantis.request-proof.v1"),
    evidence: evidenceSchema.nullable(),
    execution_outcome: executionSchema,
    assertion_outcome: z.enum(["pass", "fail", "inconclusive"]),
    observations: z.array(observationSchema).max(32),
    limits: z.array(bounded).min(1).max(16),
    reason: bounded.optional(),
  })
  .superRefine((receipt, context) => {
    const allowed =
      receipt.scenario === telegramQaScenario
        ? {
            "qa-execution": "qa-execution.json",
            "qa-result": "qa-result.json",
            "qa-observations": "qa-observations.json",
          }
        : receipt.scenario === "telegram-bot-e2e-proof"
          ? {
              "telegram-send": "telegram-send.json",
              "provider-request": "provider-request.json",
              "telegram-reply": "telegram-reply.json",
            }
          : {
              "chat-send": "chat-send.json",
              "final-reply": "final-reply.json",
              "final-screenshot": "final-reply.png",
            };
    for (const item of receipt.observations) {
      if (
        !Object.entries(allowed).some(([id, file]) => item.id === id && item.source_path === file)
      ) {
        context.addIssue({ code: "custom", message: "Cross-transport observation" });
      }
    }
    const ids = receipt.observations.map((item) => item.id);
    const paths = receipt.observations.map((item) => item.source_path);
    if (new Set(ids).size !== ids.length || new Set(paths).size !== paths.length) {
      context.addIssue({ code: "custom", message: "Duplicate observation" });
    }
    if (
      receipt.assertion_outcome !== "inconclusive" &&
      (!receipt.evidence ||
        receipt.execution_outcome !== "completed" ||
        receipt.observations.length !== 3 ||
        receipt.observations.some(
          (item) => item.authority !== "trusted_observer" || item.availability !== "present",
        ))
    ) {
      context.addIssue({
        code: "custom",
        message: "Conclusive assertions require complete trusted observations",
      });
    }
  });
export type RequestIdentity = z.infer<typeof requestIdentitySchema>;
export type RequestReceipt = z.infer<typeof requestReceiptSchema>;
export type RequestExecution = z.infer<typeof executionSchema>;
export type RequestEvidence = z.infer<typeof evidenceSchema>;
const telegramFailureDiagnosticsSchema = z
  .array(
    z.strictObject({
      sequence: z.number().int().min(1).max(16),
      category: z.enum([
        "authority_unavailable",
        "scope_rejected",
        "malformed_request",
        "upstream_failure",
        "network_failure",
      ]),
    }),
  )
  .min(1)
  .max(16)
  .refine(
    (entries) => entries.every((entry, index) => entry.sequence === index + 1),
    "Noncanonical diagnostic sequence",
  );
export type TelegramFailureDiagnostic = z.infer<typeof telegramFailureDiagnosticsSchema>[number];
const telegramFailureSchema = telegramProofIdentitySchema.safeExtend({
  schema: z.literal("mantis.telegram-failure.v1"),
  assertion_outcome: z.literal("inconclusive"),
  diagnostics: telegramFailureDiagnosticsSchema,
});
export function createTelegramFailureDiagnostic(identity: unknown, diagnostics: unknown) {
  return telegramFailureSchema.parse({
    ...telegramProofIdentitySchema.parse(identity),
    schema: "mantis.telegram-failure.v1",
    assertion_outcome: "inconclusive",
    diagnostics,
  });
}
const filesSchema = z.strictObject({
  "observer.json": z.string(),
  "chat-send.json": z.string(),
  "final-reply.json": z.string(),
  "final-reply.png": z.string(),
});
const filenames = ["chat-send.json", "final-reply.json", "final-reply.png"] as const;
const inventorySchema = z.strictObject({
  schema: z.literal("mantis.web-ui-observer.v1"),
  inventory: z.array(z.strictObject({ path: z.enum(filenames), sha256: digest })).length(3),
});
const requestRecordSchema = z.strictObject({
  expected: z.strictObject({
    deliver: z.literal(false),
    message: z.string().regex(/^Mantis request [0-9a-f-]{36}$/),
    sessionKey: z.literal("agent:main:main"),
  }),
  actual: z.record(z.string(), z.unknown()),
  request_count: z.literal(1),
});
const replyRecordSchema = z.strictObject({
  expected: z.string().regex(/^Mantis reply [0-9a-f-]{36}$/),
  actual: z.string().max(2048),
});
export function requestEvidenceDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Inputs are supplied only by the fresh trusted finalizer after it verifies
// artifact/run ownership and hashes the downloaded ZIP, not candidate metadata.
export function createRequestReceipt(
  identity: RequestIdentity,
  execution: RequestExecution,
  evidence: RequestEvidence | null,
  encodedFiles: unknown,
  reason?: string,
): RequestReceipt {
  const receipt: RequestReceipt = {
    ...requestIdentitySchema.parse(identity),
    schema: "mantis.request-proof.v1",
    execution_outcome: executionSchema.parse(execution),
    evidence: evidenceSchema.nullable().parse(evidence),
    assertion_outcome: "inconclusive",
    observations: [],
    limits:
      identity.scenario === telegramQaScenario
        ? [
            "Actual candidate Gateway send and Telegram formatter against a Crabline Bot API emulator; no Telegram Test Server, TDLib, live model, or readiness claim.",
            "The trusted canonical telegram-markdown-parser-fidelity recipe judges four formatting cases. Candidate code has no real credentials, host mounts, observer files, or external network.",
            "Only the ephemeral trusted observer uses OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 for its isolated container hostname and synthetic per-run Gateway token; no host configuration is changed.",
          ]
        : identity.scenario === "telegram-bot-e2e-proof"
          ? [
              "Selected data-only Test Server DM scenario with deterministic model replies; no production/personal traffic, live model, group, media, or readiness claim.",
              "Canonical trusted TDLib recorder and provider capture are outside the isolated candidate; raw identities and credentials are not public observations.",
              "The original reviewer evaluates the complete bounded observations; a completed recording is not a passing assertion. Bot registration and webhook administration are simulated; TDLib background traffic is not claimed to cease at the action deadline.",
            ]
          : [
              "Black-box behavior of the served candidate UI during external browser input, with a mocked Gateway. No internal client/callsite provenance, live Gateway, provider, channel, delivery, or readiness claim.",
              "Candidate dependency inputs must match the trusted harness; candidate install hooks and build run offline. Observer capture is separate with Chromium sandbox enabled and no external network.",
              "Production build-identity admission is not covered: this scenario uses the canonical mock Gateway e2e build ID.",
            ],
  };
  if (
    identity.scenario === "telegram-bot-e2e-proof" &&
    encodedFiles &&
    typeof encodedFiles === "object" &&
    Object.hasOwn(encodedFiles, "telegram-failure.json")
  ) {
    try {
      const encoded = z
        .strictObject({ "telegram-failure.json": z.string().max(22000) })
        .parse(encodedFiles);
      const bytes = Buffer.from(encoded["telegram-failure.json"], "base64");
      if (bytes.length > 16384 || bytes.toString("base64") !== encoded["telegram-failure.json"]) {
        throw new Error("Invalid diagnostic encoding");
      }
      const diagnostic = telegramFailureSchema.parse(JSON.parse(bytes.toString("utf8")));
      const actualIdentity = requestIdentitySchema.parse(
        telegramProofIdentitySchema.parse({
          request_id: diagnostic.request_id,
          plan_sha256: diagnostic.plan_sha256,
          repository: diagnostic.repository,
          pull_request: diagnostic.pull_request,
          candidate_sha: diagnostic.candidate_sha,
          scenario: diagnostic.scenario,
          workflow: diagnostic.workflow,
          harness: diagnostic.harness,
          run: diagnostic.run,
        }),
      );
      if (
        JSON.stringify(actualIdentity) !== JSON.stringify(requestIdentitySchema.parse(identity)) ||
        !evidence
      ) {
        throw new Error("Diagnostic identity mismatch");
      }
      receipt.reason =
        reason ??
        `Telegram proof inconclusive: ${diagnostic.diagnostics.map((entry) => `${entry.sequence}:${entry.category}`).join(", ")}.`;
    } catch {
      receipt.reason =
        reason ??
        "Telegram failure diagnostic is malformed, oversized, or does not match the exact request identity.";
    }
    receipt.limits.push(receipt.reason);
    return requestReceiptSchema.parse(receipt);
  }
  if (!evidence || execution !== "completed" || reason) {
    receipt.reason =
      reason ??
      "Execution or evidence is missing, incomplete, skipped, cancelled, timed out, or failed.";
    receipt.limits.push(receipt.reason);
    return requestReceiptSchema.parse(receipt);
  }
  try {
    if (identity.scenario === telegramQaScenario) {
      const qa = verifyTelegramQaFiles(identity, encodedFiles);
      receipt.observations = qa.observations;
      receipt.assertion_outcome = qa.assertion_outcome;
      return requestReceiptSchema.parse(receipt);
    }
    if (identity.scenario === "telegram-bot-e2e-proof") {
      const telegram = verifyTelegramProofFiles(
        telegramProofIdentitySchema.parse(identity),
        encodedFiles,
      );
      receipt.observations = telegram.observations;
      receipt.assertion_outcome = telegram.assertion_outcome;
      return requestReceiptSchema.parse(receipt);
    }
    const encoded = filesSchema.parse(encodedFiles);
    const decode = (value: string, maximum: number) => {
      if (value.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
        throw new Error("Invalid encoded evidence");
      }
      const bytes = Buffer.from(value, "base64");
      if (bytes.length > maximum) {
        throw new Error("Oversized evidence");
      }
      return bytes;
    };
    const files = {
      "observer.json": decode(encoded["observer.json"], 65536),
      "chat-send.json": decode(encoded["chat-send.json"], 65536),
      "final-reply.json": decode(encoded["final-reply.json"], 65536),
      "final-reply.png": decode(encoded["final-reply.png"], 16 * 1024 * 1024),
    };
    const inventory = inventorySchema.parse(JSON.parse(files["observer.json"].toString("utf8")));
    if (new Set(inventory.inventory.map((item) => item.path)).size !== 3) {
      throw new Error("Duplicate inventory");
    }
    for (const item of inventory.inventory) {
      if (requestEvidenceDigest(files[item.path]) !== item.sha256) {
        throw new Error("Observation digest mismatch");
      }
    }
    if (
      !files["final-reply.png"]
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
      throw new Error("Missing PNG capture");
    }
    const send = requestRecordSchema.parse(JSON.parse(files["chat-send.json"].toString("utf8")));
    const reply = replyRecordSchema.parse(JSON.parse(files["final-reply.json"].toString("utf8")));
    const matches =
      send.actual.deliver === false &&
      send.actual.message === send.expected.message &&
      send.actual.sessionKey === send.expected.sessionKey &&
      typeof send.actual.idempotencyKey === "string" &&
      send.actual.idempotencyKey.length > 0 &&
      send.actual.idempotencyKey.length <= 256 &&
      reply.actual === reply.expected;
    const observed = [
      {
        id: "chat-send",
        expected: JSON.stringify(send.expected),
        actual: JSON.stringify(send.actual),
        source_path: "chat-send.json",
      },
      {
        id: "final-reply",
        expected: reply.expected,
        actual: reply.actual,
        source_path: "final-reply.json",
      },
      {
        id: "final-screenshot",
        expected: "Screenshot after final reply is visible",
        actual: "Captured by trusted browser driver after visible final reply",
        source_path: "final-reply.png",
      },
    ] as const;
    receipt.observations = observed.map((item) => ({
      id: item.id,
      expected: item.expected,
      actual: item.actual,
      source_path: item.source_path,
      sha256: requestEvidenceDigest(files[item.source_path]),
      availability: "present",
      authority: "trusted_observer",
    }));
    receipt.assertion_outcome = matches ? "pass" : "fail";
    return requestReceiptSchema.parse(receipt);
  } catch {
    receipt.observations = [];
    receipt.assertion_outcome = "inconclusive";
    receipt.limits.push(
      "Observation inventory is malformed, missing, partial, oversized, or has a digest mismatch.",
    );
    return requestReceiptSchema.parse(receipt);
  }
}
