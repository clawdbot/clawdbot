import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";

import { resolveStateDir } from "../config/paths.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { resolveUserPath } from "../utils.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

type PayloadLogStage = "request" | "usage";

type PayloadLogEvent = {
  ts: string;
  stage: PayloadLogStage;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  payload?: unknown;
  usage?: Record<string, unknown>;
  error?: string;
  payloadDigest?: string;
};

type PayloadLogConfig = {
  enabled: boolean;
  filePath: string;
};

type PayloadLogWriter = {
  filePath: string;
  write: (line: string) => void;
};

const writers = new Map<string, PayloadLogWriter>();
const log = createSubsystemLogger("agent/anthropic-payload");

function resolvePayloadLogConfig(env: NodeJS.ProcessEnv): PayloadLogConfig {
  const enabled = parseBooleanValue(env.CLAWDBOT_ANTHROPIC_PAYLOAD_LOG) ?? false;
  const fileOverride = env.CLAWDBOT_ANTHROPIC_PAYLOAD_LOG_FILE?.trim();
  const filePath = fileOverride
    ? resolveUserPath(fileOverride)
    : path.join(resolveStateDir(env), "logs", "anthropic-payload.jsonl");
  return { enabled, filePath };
}

function getWriter(filePath: string): PayloadLogWriter {
  const existing = writers.get(filePath);
  if (existing) return existing;

  const dir = path.dirname(filePath);
  const ready = fs.mkdir(dir, { recursive: true }).catch(() => undefined);
  let queue = Promise.resolve();

  const writer: PayloadLogWriter = {
    filePath,
    write: (line: string) => {
      queue = queue
        .then(() => ready)
        .then(() => fs.appendFile(filePath, line, "utf8"))
        .catch(() => undefined);
    },
  };

  writers.set(filePath, writer);
  return writer;
}

function safeJsonStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") return val.toString();
      if (typeof val === "function") return "[Function]";
      if (val instanceof Error) {
        return { name: val.name, message: val.message, stack: val.stack };
      }
      if (val instanceof Uint8Array) {
        return { type: "Uint8Array", data: Buffer.from(val).toString("base64") };
      }
      return val;
    });
  } catch {
    return null;
  }
}

function digest(value: unknown): string | undefined {
  const serialized = safeJsonStringify(value);
  if (!serialized) return undefined;
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function isAnthropicModel(model: Model<Api> | undefined | null): boolean {
  return (model as { api?: unknown })?.api === "anthropic-messages";
}

function findLastAssistantUsage(messages: AgentMessage[]): Record<string, unknown> | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i] as { role?: unknown; usage?: unknown };
    if (msg?.role === "assistant" && msg.usage && typeof msg.usage === "object") {
      return msg.usage as Record<string, unknown>;
    }
  }
  return null;
}

export type AnthropicPayloadLogger = {
  enabled: true;
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
  recordUsage: (messages: AgentMessage[], error?: unknown) => void;
};

export function createAnthropicPayloadLogger(params: {
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
}): AnthropicPayloadLogger | null {
  const env = params.env ?? process.env;
  const cfg = resolvePayloadLogConfig(env);
  if (!cfg.enabled) return null;

  const writer = getWriter(cfg.filePath);
  const base: Omit<PayloadLogEvent, "ts" | "stage"> = {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    workspaceDir: params.workspaceDir,
  };

  const record = (event: PayloadLogEvent) => {
    const line = safeJsonStringify(event);
    if (!line) return;
    writer.write(`${line}\n`);
  };

  const wrapStreamFn: AnthropicPayloadLogger["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      if (!isAnthropicModel(model as Model<Api>)) {
        return streamFn(model, context, options);
      }
      const nextOnPayload = (payload: unknown) => {
        record({
          ...base,
          ts: new Date().toISOString(),
          stage: "request",
          payload,
          payloadDigest: digest(payload),
        });
        options?.onPayload?.(payload);
      };
      return streamFn(model, context, {
        ...(options ?? {}),
        onPayload: nextOnPayload,
      });
    };
    return wrapped;
  };

  const recordUsage: AnthropicPayloadLogger["recordUsage"] = (messages, error) => {
    const usage = findLastAssistantUsage(messages);
    if (!usage) {
      if (error) {
        record({
          ...base,
          ts: new Date().toISOString(),
          stage: "usage",
          error: String(error),
        });
      }
      return;
    }
    record({
      ...base,
      ts: new Date().toISOString(),
      stage: "usage",
      usage,
      error: error ? String(error) : undefined,
    });
    log.info("anthropic usage", {
      runId: params.runId,
      sessionId: params.sessionId,
      usage,
    });
  };

  log.info("anthropic payload logger enabled", { filePath: writer.filePath });
  return { enabled: true, wrapStreamFn, recordUsage };
}
