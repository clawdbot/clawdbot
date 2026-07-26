import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import type {
  PluginHookToolResultPersistEvent,
  PluginHookToolResultPersistResult,
} from "openclaw/plugin-sdk/types";
import { parseToolInput, type OnePasswordBroker } from "./broker.js";
import { OnePasswordError } from "./errors.js";
import { AUTHORIZATION_NONCE_PARAM } from "./pending-authorization.js";

const OnePasswordToolSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["list", "get"],
      description: "List registered secret slugs or get one registered secret.",
    },
    slug: {
      type: "string",
      pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
      description: "Registered secret slug. Required for get.",
    },
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 300,
      description: "Why the agent needs this secret. Required for get.",
    },
    authorizationNonce: {
      type: "string",
      description: "Internal. Injected by the gateway policy layer; never set this manually.",
    },
  },
} as unknown as AnyAgentTool["parameters"];

function errorResult(error: unknown) {
  const code =
    error instanceof OnePasswordError
      ? error.code
      : error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "OP_ERROR";
  const message = error instanceof Error ? error.message : "1Password request failed";
  return jsonResult({ ok: false, error: { code, message } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function redactPersistedOnePasswordResult(
  event: PluginHookToolResultPersistEvent,
): PluginHookToolResultPersistResult | undefined {
  if (
    event.message.role !== "toolResult" ||
    (event.toolName ?? event.message.toolName) !== "onepassword"
  ) {
    return undefined;
  }
  const details = event.message.details;
  const contentText = event.message.content
    .filter(
      (part): part is Extract<(typeof event.message.content)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
  const hasSecretValue =
    (isRecord(details) && typeof details.value === "string") || /"value"\s*:/.test(contentText);
  if (!hasSecretValue) {
    return undefined;
  }
  const safeDetails = isRecord(details) ? details : {};
  const persisted = {
    ok: true,
    redacted: true,
    ...(typeof safeDetails.slug === "string" ? { slug: safeDetails.slug } : {}),
    ...(typeof safeDetails.itemTitle === "string" ? { itemTitle: safeDetails.itemTitle } : {}),
    ...(typeof safeDetails.fieldLabel === "string" ? { fieldLabel: safeDetails.fieldLabel } : {}),
  };
  return {
    message: {
      ...event.message,
      content: [{ type: "text", text: JSON.stringify(persisted, null, 2) }],
      details: persisted,
    },
  };
}

export function createOnePasswordTool(
  broker: OnePasswordBroker,
  invocation: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "onepassword",
    label: "1Password",
    description:
      "List curated 1Password secret slugs or retrieve one secret under its configured access policy.",
    parameters: OnePasswordToolSchema,
    execute: async (toolCallId, rawParams) => {
      const params =
        rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
          ? (rawParams as Record<string, unknown>)
          : {};
      try {
        const input = parseToolInput(params);
        if (input.action === "list") {
          return jsonResult({ ok: true, items: await broker.list(invocation) });
        }
        const nonceValue = params[AUTHORIZATION_NONCE_PARAM];
        const nonce = typeof nonceValue === "string" ? nonceValue : undefined;
        const secret = await broker.get(toolCallId, input, invocation, nonce);
        return jsonResult({ ok: true, ...secret });
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}
