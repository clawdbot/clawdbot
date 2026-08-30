import { asNullableRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import {
  validateSecretsStoreListResult,
  type QuestionRequestQuestion,
  type QuestionWaitAnswerResult,
  type SecretsStoreListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ENV_SECRET_REF_ID_RE, type SecretRef } from "../../config/types.secrets.js";
import { ADMIN_SCOPE } from "../../gateway/operator-scopes.js";
import { resolveDefaultSecretProviderAlias } from "../../secrets/ref-contract.js";
import { stringEnum } from "../schema/string-enum.js";
import { describeSecretsTool } from "../tool-description-presets.js";
import { normalizeQuestionTimeoutSeconds } from "./ask-user-tool-normalization.js";
import { beginAskUserPromptDelivery } from "./ask-user-tool.js";
import { type AnyAgentTool, readToolStringParam, ToolInputError } from "./common.js";
import {
  awaitGatewayQuestionAnswer,
  createGatewayQuestionCanceller,
  type GatewayQuestionCall,
} from "./gateway-question-lifecycle.js";
import { callGatewayTool } from "./gateway.js";
import { jsonResult, textResult } from "./tool-results.js";

type SecretStoreKind = "secret";
const SecretsToolSchema = Type.Object(
  {
    action: stringEnum(["request", "list", "delete"], {
      description: "`request` a value from the human, `list` entry metadata, or `delete` an entry.",
    }),
    name: Type.Optional(
      Type.String({
        maxLength: 128,
        pattern: "^[A-Z][A-Z0-9_]{0,127}$",
        description:
          "Entry name in uppercase environment-variable form, also its SecretRef id (STRIPE_API_KEY). Required for request and delete.",
      }),
    ),
    kind: Type.Optional(
      stringEnum(["secret"], {
        description: "Only `secret` may be requested; requested values are never readable back.",
      }),
    ),
    allowedHosts: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 253 }), {
        maxItems: 128,
        uniqueItems: true,
        description:
          "Exact hostnames allowed to receive a secret, without scheme or port (api.stripe.com). Leaving this empty prevents egress substitution; config SecretRefs remain usable.",
      }),
    ),
    reason: Type.Optional(
      Type.String({
        maxLength: 200,
        description: "One line shown to the human explaining why the credential is needed.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Integer({
        description:
          "Maximum human wait in seconds on request; default 900, clamped 30-3600. Earlier run cancellation or overall run timeout still applies.",
      }),
    ),
  },
  { additionalProperties: false },
);

type NormalizedSecretsRequestParams = {
  name: string;
  kind: SecretStoreKind;
  allowedHosts?: string[];
  reason?: string;
  timeoutSeconds: number;
  questions: QuestionRequestQuestion[];
};

function readSecretStoreName(params: Record<string, unknown>): string {
  const name = readToolStringParam(params, "name", { required: true });
  if (!ENV_SECRET_REF_ID_RE.test(name)) {
    throw new ToolInputError("name must be an uppercase environment-variable name");
  }
  return name;
}

/** Normalizes one secure question for both tool-start reservation and tool execution. */
export function normalizeSecretsRequestParams(value: unknown): NormalizedSecretsRequestParams {
  if (!isRecord(value)) {
    throw new ToolInputError("secrets arguments must be an object");
  }
  const params = value;
  const name = readSecretStoreName(params);
  // Requests are secret-only on purpose: `list` renders env values, so an
  // agent-requested env entry would be readable straight back through this
  // tool, breaking the promise the masked prompt makes to the human.
  const kind = readToolStringParam(params, "kind", { required: false }) ?? "secret";
  if (kind !== "secret") {
    throw new ToolInputError(
      'kind must be "secret"; environment values are set in Settings or the CLI, not requested from the model',
    );
  }
  const allowedHosts = params.allowedHosts;
  if (allowedHosts !== undefined) {
    if (
      !Array.isArray(allowedHosts) ||
      allowedHosts.length > 128 ||
      allowedHosts.some((host) => typeof host !== "string" || !host || host.length > 253) ||
      new Set(allowedHosts).size !== allowedHosts.length
    ) {
      throw new ToolInputError("allowedHosts must contain up to 128 unique non-empty hostnames");
    }
  }
  if (params.reason !== undefined && typeof params.reason !== "string") {
    throw new ToolInputError("reason must be a string");
  }
  const reason = typeof params.reason === "string" ? params.reason.trim() : undefined;
  if (reason && reason.length > 200) {
    throw new ToolInputError("reason must be at most 200 characters");
  }
  const timeoutSeconds = normalizeQuestionTimeoutSeconds(params.timeoutSeconds);
  const binding: NonNullable<QuestionRequestQuestion["secretStore"]> = {
    name,
    kind: "secret",
    ...(allowedHosts !== undefined ? { allowedHosts } : {}),
    ...(reason ? { reason } : {}),
  };
  const question = `Provide the secret for ${name}.`;
  return {
    ...binding,
    kind: "secret",
    timeoutSeconds,
    questions: [
      {
        questionId: "secret_value",
        header: "API key",
        question,
        options: [],
        isSecret: true,
        secretStore: binding,
      },
    ],
  };
}

function noSecretAnswerResult(status: "pending" | "expired" | "cancelled") {
  const details = { status: "no_answer" as const };
  const note =
    status === "cancelled"
      ? "The credential request was cancelled; proceed with best judgment."
      : "No credential arrived; proceed with best judgment.";
  return textResult(`${note}\n\n${JSON.stringify(details, null, 2)}`, details);
}

async function fetchSecretStore(gatewayCall: GatewayQuestionCall, signal?: AbortSignal) {
  const result = await gatewayCall("secrets.store.list", {}, {}, signal ? { signal } : undefined);
  if (!validateSecretsStoreListResult(result)) {
    throw new Error("secrets.store.list returned invalid metadata");
  }
  return result;
}

async function storedSecretResult(
  params: NormalizedSecretsRequestParams,
  provider: string,
  gatewayCall: GatewayQuestionCall,
  signal?: AbortSignal,
) {
  // This read observes current policy, not the earlier approval. Its failure
  // cannot undo a committed save; never expose the inventory or read error.
  const currentPolicy = await fetchSecretStore(gatewayCall, signal)
    .then(({ entries }) => {
      const entry = entries.find((candidate) => candidate.name === params.name);
      if (!entry) {
        return { status: "missing" as const };
      }
      if (entry.kind !== "secret") {
        return { status: "kind_changed" as const };
      }
      const allowedHosts = entry.allowedHosts;
      if (allowedHosts === undefined) {
        return { status: "unavailable" as const };
      }
      // Return the complete policy or only its count, never a misleading prefix.
      return JSON.stringify(allowedHosts).length > 512
        ? { status: "omitted" as const, allowedHostCount: allowedHosts.length }
        : { status: "available" as const, allowedHosts };
    })
    .catch(() => ({ status: "unavailable" as const }));
  signal?.throwIfAborted();

  const details = {
    status: "stored" as const,
    name: params.name,
    kind: params.kind,
    ref: { source: "store", provider, id: params.name } satisfies SecretRef,
    currentPolicy,
  };
  const guidance = [
    "Stored; value hidden. Use the returned ref for config SecretRefs.",
    "currentPolicy is this entry's current host list; the human may edit it. Not Gateway config or an approval receipt; may change later.",
    "Report current hosts, not proposed hosts. Do not infer why they differ or prescribe Gateway config changes from the difference.",
    "Only available hosts are complete; [] means no egress. Otherwise make no host claims.",
    "Stored does not prove proxy enabled or current exec snapshot; config refs are independent.",
  ];
  return textResult(`${guidance.join(" ")}\n\n${JSON.stringify(details)}`, details);
}

function listSecretStoreResult(result: SecretsStoreListResult) {
  const lines = result.entries.map((entry) => {
    const fields = [entry.name, entry.kind];
    if (entry.kind === "secret" && entry.allowedHosts?.length) {
      fields.push(`hosts: ${entry.allowedHosts.join(", ")}`);
    }
    if (entry.kind === "env") {
      fields.push(`value: ${entry.value}`);
    }
    fields.push(`updated: ${new Date(entry.updatedAtMs).toISOString()}`);
    if (entry.updatedBy) {
      fields.push(`by: ${entry.updatedBy}`);
    }
    return fields.join(" | ");
  });
  return textResult(lines.length ? lines.join("\n") : "The secret store is empty.", result);
}

/** Creates the metadata-only secret-store tool and its human-entered write flow. */
export function createSecretsTool(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  gatewayCall?: GatewayQuestionCall;
}): AnyAgentTool {
  const gatewayCall: GatewayQuestionCall = params.gatewayCall ?? callGatewayTool;
  const storeProvider = resolveDefaultSecretProviderAlias(params.config ?? {}, "store");
  return {
    label: "Secrets",
    name: "secrets",
    description: describeSecretsTool(),
    parameters: SecretsToolSchema,
    execute: async (toolCallId, args, signal) => {
      if (!isRecord(args)) {
        throw new ToolInputError("secrets arguments must be an object");
      }
      const input = args;
      const action = readToolStringParam(input, "action", { required: true });
      if (action === "list") {
        return listSecretStoreResult(await fetchSecretStore(gatewayCall, signal));
      }
      if (action === "delete") {
        const name = readSecretStoreName(input);
        const result = await gatewayCall(
          "secrets.store.delete",
          {},
          { name },
          { requireAgentRuntimeIdentity: true, ...(signal ? { signal } : {}) },
        );
        return jsonResult(result);
      }
      if (action !== "request") {
        throw new ToolInputError(`Unknown secrets action: ${action}`);
      }
      const request = normalizeSecretsRequestParams(input);
      const delivery = beginAskUserPromptDelivery({
        toolCallId,
        sessionKey: params.sessionKey,
        runId: params.runId,
        agentId: params.agentId,
        questions: request.questions,
        timeoutSeconds: request.timeoutSeconds,
      });
      const timeoutMs = request.timeoutSeconds * 1_000;
      let registered = false;
      const cancelPendingQuestion = createGatewayQuestionCanceller({
        gatewayCall,
        questionId: delivery.questionId,
      });
      const cancelOnAbort = () => {
        delivery.release();
        void cancelPendingQuestion("run-abort");
      };
      try {
        signal?.throwIfAborted();
        const registration = asNullableRecord(
          await gatewayCall(
            "question.request",
            {},
            {
              id: delivery.questionId,
              questions: request.questions,
              ...(params.agentId ? { agentId: params.agentId } : {}),
              ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
              ...(params.runId ? { runId: params.runId } : {}),
              timeoutMs,
            },
            // Store-bound requests are gated on an admin client server-side; the
            // default least-privilege scope for question.request is not enough.
            {
              scopes: [ADMIN_SCOPE],
              requireAgentRuntimeIdentity: true,
              ...(signal ? { signal } : {}),
            },
          ),
        );
        registered = true;
        if (registration?.id !== delivery.questionId) {
          throw new Error("question.request returned an unexpected question id");
        }
        signal?.addEventListener("abort", cancelOnAbort, { once: true });
        if (signal?.aborted) {
          cancelOnAbort();
          signal.throwIfAborted();
        }
        const answerPromise = awaitGatewayQuestionAnswer({
          gatewayCall,
          questionId: delivery.questionId,
          timeoutMs,
          ...(signal ? { signal } : {}),
        });
        delivery.markReady();
        let questionResult: QuestionWaitAnswerResult | undefined;
        if (delivery.hasSubscriber) {
          const first = await Promise.race([
            delivery.waitForDelivery(signal).then((result) => ({
              kind: "delivery" as const,
              result,
            })),
            answerPromise.then((result) => ({ kind: "answer" as const, result })),
          ]);
          if (first.kind === "delivery" && first.result.error !== undefined) {
            questionResult = await cancelPendingQuestion("prompt-delivery-failed");
            signal?.throwIfAborted();
            if (!questionResult) {
              throw new Error("credential-request prompt delivery failed", {
                cause: first.result.error,
              });
            }
          }
        }
        questionResult ??= await answerPromise;
        if (questionResult.status === "pending") {
          questionResult = (await cancelPendingQuestion("wait-timeout")) ?? questionResult;
        }
        signal?.throwIfAborted();
        // Cancellation can lose to a committed answer; validate every recovered marker here too.
        if (questionResult.status === "answered") {
          if (questionResult.answers.answers.secret_value?.[0] !== "stored") {
            throw new Error("credential request returned an unexpected answer marker");
          }
          return await storedSecretResult(request, storeProvider, gatewayCall, signal);
        }
        if (
          questionResult.status === "pending" ||
          questionResult.status === "expired" ||
          questionResult.status === "cancelled"
        ) {
          return noSecretAnswerResult(questionResult.status);
        }
        throw new Error("question.waitAnswer returned an invalid status");
      } catch (error) {
        if (registered || signal?.aborted) {
          await cancelPendingQuestion(signal?.aborted ? "run-abort" : "tool-error");
        }
        throw error;
      } finally {
        signal?.removeEventListener("abort", cancelOnAbort);
        delivery.release();
      }
    },
  };
}
