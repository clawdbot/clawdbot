import { asNullableRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  QuestionWaitAnswerResultSchema,
  validateSecretsStoreListResult,
  type QuestionRequestQuestion,
  type QuestionWaitAnswerResult,
  type SecretsStoreListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { ENV_SECRET_REF_ID_RE } from "../../config/types.secrets.js";
import { ADMIN_SCOPE } from "../../gateway/operator-scopes.js";
import { stringEnum } from "../schema/string-enum.js";
import { DEFAULT_ASK_USER_TIMEOUT_SECONDS } from "./ask-user-tool-normalization.js";
import { beginAskUserPromptDelivery } from "./ask-user-tool.js";
import { type AnyAgentTool, readToolStringParam, ToolInputError } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";
import { jsonResult, textResult } from "./tool-results.js";

const SECRETS_RPC_GRACE_MS = 10_000;
const SECRET_STORE_KINDS = ["secret", "env"] as const;
type SecretStoreKind = (typeof SECRET_STORE_KINDS)[number];
type SecretsGatewayCall = (
  method: string,
  opts: GatewayCallOptions,
  params?: unknown,
  extra?: {
    signal?: AbortSignal;
    requireAgentRuntimeIdentity?: boolean;
    scopes?: (typeof ADMIN_SCOPE)[];
  },
) => Promise<unknown>;

const SecretsToolSchema = Type.Object(
  {
    action: stringEnum(["request", "list", "delete"]),
    name: Type.Optional(Type.String({ maxLength: 128, pattern: "^[A-Z][A-Z0-9_]{0,127}$" })),
    kind: Type.Optional(stringEnum(SECRET_STORE_KINDS)),
    allowedHosts: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 253 }), {
        maxItems: 128,
        uniqueItems: true,
      }),
    ),
    reason: Type.Optional(Type.String({ maxLength: 200 })),
    timeoutSeconds: Type.Optional(Type.Integer()),
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
  const kind = readToolStringParam(params, "kind", { required: true });
  if (kind !== "secret" && kind !== "env") {
    throw new ToolInputError('kind must be "secret" or "env"');
  }
  const allowedHosts = params.allowedHosts;
  if (allowedHosts !== undefined) {
    if (kind !== "secret") {
      throw new ToolInputError("allowedHosts is only supported for secret entries");
    }
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
  const timeout = params.timeoutSeconds;
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" || !Number.isFinite(timeout) || !Number.isInteger(timeout))
  ) {
    throw new ToolInputError("timeoutSeconds must be an integer");
  }
  const timeoutSeconds = Math.min(3_600, Math.max(30, timeout ?? DEFAULT_ASK_USER_TIMEOUT_SECONDS));
  const binding: NonNullable<QuestionRequestQuestion["secretStore"]> = {
    name,
    kind,
    ...(allowedHosts !== undefined ? { allowedHosts } : {}),
    ...(reason ? { reason } : {}),
  };
  const question = `Provide ${kind === "secret" ? "the secret" : "the environment value"} for ${name}.${reason ? ` ${reason}` : ""}`;
  return {
    ...binding,
    timeoutSeconds,
    questions: [
      {
        questionId: "secret_value",
        header: kind === "secret" ? "API key" : "Environment",
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

function storedSecretResult(params: NormalizedSecretsRequestParams, replacedExisting: boolean) {
  const details = {
    status: "stored" as const,
    name: params.name,
    kind: params.kind,
    ...(params.allowedHosts !== undefined ? { allowedHosts: params.allowedHosts } : {}),
    replacedExisting,
    ref: { source: "store" as const, id: params.name },
  };
  const guidance = [
    `Stored ${params.name} without exposing its value.`,
    `Reference {source:"store", id:"${params.name}"} in config SecretRefs.`,
    "Environment entries appear in gateway-host exec environments on the NEXT agent run.",
    "Secret values are substituted at egress only when secrets.egressProxy.enabled is true and the destination matches their allowed hosts.",
  ];
  return textResult(`${guidance.join(" ")}\n\n${JSON.stringify(details, null, 2)}`, details);
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
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  gatewayCall?: SecretsGatewayCall;
}): AnyAgentTool {
  const gatewayCall: SecretsGatewayCall = params.gatewayCall ?? callGatewayTool;
  return {
    label: "Secrets",
    name: "secrets",
    description:
      "Write-only store; values are never returned by any action. To store a value, use `request` — the human enters it directly. List entry metadata or delete an existing entry.",
    parameters: SecretsToolSchema,
    execute: async (toolCallId, args, signal) => {
      if (!isRecord(args)) {
        throw new ToolInputError("secrets arguments must be an object");
      }
      const input = args;
      const action = readToolStringParam(input, "action", { required: true });
      if (action === "list") {
        const result = await gatewayCall(
          "secrets.store.list",
          {},
          {},
          signal ? { signal } : undefined,
        );
        if (!validateSecretsStoreListResult(result)) {
          throw new Error("secrets.store.list returned invalid metadata");
        }
        return listSecretStoreResult(result);
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
      let cancellation: Promise<unknown> | undefined;
      const cancelPendingQuestion = (resolvedBy: string) => {
        cancellation ??= gatewayCall(
          "question.resolve",
          { timeoutMs: SECRETS_RPC_GRACE_MS },
          { id: delivery.questionId, cancel: true, resolvedBy },
        ).catch(() => undefined);
        return cancellation;
      };
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
            // Store-bound requests are gated on an admin client server-side;
            // the default least-privilege scope for question.request is not enough.
            { scopes: [ADMIN_SCOPE], ...(signal ? { signal } : {}) },
          ),
        );
        registered = true;
        if (registration?.id !== delivery.questionId) {
          throw new Error("question.request returned an unexpected question id");
        }
        const record = await gatewayCall(
          "question.get",
          {},
          { id: delivery.questionId },
          signal ? { signal } : undefined,
        ).catch(() => undefined);
        const questionRecord = asNullableRecord(asNullableRecord(record)?.question);
        const questions = questionRecord?.questions;
        const replacedExisting =
          Array.isArray(questions) &&
          asNullableRecord(questions[0])?.secretStoreExisting !== undefined;
        signal?.addEventListener("abort", cancelOnAbort, { once: true });
        if (signal?.aborted) {
          cancelOnAbort();
          signal.throwIfAborted();
        }
        const answerPromise = gatewayCall(
          "question.waitAnswer",
          { timeoutMs: timeoutMs + SECRETS_RPC_GRACE_MS },
          { id: delivery.questionId, timeoutMs },
          signal ? { signal } : undefined,
        ).then((result): QuestionWaitAnswerResult => {
          if (!Value.Check(QuestionWaitAnswerResultSchema, result)) {
            throw new Error("question.waitAnswer returned an invalid status");
          }
          return result;
        });
        delivery.markReady();
        if (delivery.hasSubscriber) {
          const first = await Promise.race([
            delivery.waitForDelivery(signal).then((result) => ({
              kind: "delivery" as const,
              result,
            })),
            answerPromise.then((result) => ({ kind: "answer" as const, result })),
          ]);
          if (first.kind === "delivery" && first.result.error !== undefined) {
            await cancelPendingQuestion("prompt-delivery-failed");
            throw new Error("credential-request prompt delivery failed", {
              cause: first.result.error,
            });
          }
        }
        const result = await answerPromise;
        signal?.throwIfAborted();
        if (result.status === "answered") {
          if (result.answers.answers.secret_value?.[0] !== "stored") {
            throw new Error("credential request returned an unexpected answer marker");
          }
          return storedSecretResult(request, replacedExisting);
        }
        if (result.status === "pending") {
          await cancelPendingQuestion("wait-timeout");
        }
        if (
          result.status === "pending" ||
          result.status === "expired" ||
          result.status === "cancelled"
        ) {
          return noSecretAnswerResult(result.status);
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
