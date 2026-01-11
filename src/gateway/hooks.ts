import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ClawdbotConfig } from "../config/config.js";
import {
  listProviderPlugins,
  type ProviderId,
} from "../providers/plugins/index.js";
import { normalizeMessageProvider } from "../utils/message-provider.js";
import {
  type HookMappingResolved,
  resolveHookMappings,
} from "./hooks-mapping.js";

const DEFAULT_HOOKS_PATH = "/hooks";
const DEFAULT_HOOKS_MAX_BODY_BYTES = 256 * 1024;

export type HooksConfigResolved = {
  basePath: string;
  token: string;
  maxBodyBytes: number;
  mappings: HookMappingResolved[];
};

export function resolveHooksConfig(
  cfg: ClawdbotConfig,
): HooksConfigResolved | null {
  if (cfg.hooks?.enabled !== true) return null;
  const token = cfg.hooks?.token?.trim();
  if (!token) {
    throw new Error("hooks.enabled requires hooks.token");
  }
  const rawPath = cfg.hooks?.path?.trim() || DEFAULT_HOOKS_PATH;
  const withSlash = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const trimmed =
    withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
  if (trimmed === "/") {
    throw new Error("hooks.path may not be '/'");
  }
  const maxBodyBytes =
    cfg.hooks?.maxBodyBytes && cfg.hooks.maxBodyBytes > 0
      ? cfg.hooks.maxBodyBytes
      : DEFAULT_HOOKS_MAX_BODY_BYTES;
  const mappings = resolveHookMappings(cfg.hooks);
  return {
    basePath: trimmed,
    token,
    maxBodyBytes,
    mappings,
  };
}

export function extractHookToken(
  req: IncomingMessage,
  url: URL,
): string | undefined {
  const auth =
    typeof req.headers.authorization === "string"
      ? req.headers.authorization.trim()
      : "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  const headerToken =
    typeof req.headers["x-clawdbot-token"] === "string"
      ? req.headers["x-clawdbot-token"].trim()
      : "";
  if (headerToken) return headerToken;
  const queryToken = url.searchParams.get("token");
  if (queryToken) return queryToken.trim();
  return undefined;
}

export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return await new Promise((resolve) => {
    let done = false;
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) {
        resolve({ ok: true, value: {} });
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve({ ok: true, value: parsed });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      resolve({ ok: false, error: String(err) });
    });
  });
}

export function normalizeHookHeaders(req: IncomingMessage) {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers[key.toLowerCase()] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      headers[key.toLowerCase()] = value.join(", ");
    }
  }
  return headers;
}

export function normalizeWakePayload(
  payload: Record<string, unknown>,
):
  | { ok: true; value: { text: string; mode: "now" | "next-heartbeat" } }
  | { ok: false; error: string } {
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) return { ok: false, error: "text required" };
  const mode = payload.mode === "next-heartbeat" ? "next-heartbeat" : "now";
  return { ok: true, value: { text, mode } };
}

export type HookAgentPayload = {
  message: string;
  name: string;
  wakeMode: "now" | "next-heartbeat";
  sessionKey: string;
  deliver: boolean;
  provider: HookMessageProvider;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
};

const HOOK_PROVIDER_VALUES = [
  "last",
  ...listProviderPlugins().map((plugin) => plugin.id),
];

export type HookMessageProvider = ProviderId | "last";

const hookProviderSet = new Set<string>(HOOK_PROVIDER_VALUES);
export const HOOK_PROVIDER_ERROR = `provider must be ${HOOK_PROVIDER_VALUES.join("|")}`;

export function resolveHookProvider(raw: unknown): HookMessageProvider | null {
  if (raw === undefined) return "last";
  if (typeof raw !== "string") return null;
  const normalized = normalizeMessageProvider(raw);
  if (!normalized || !hookProviderSet.has(normalized)) return null;
  return normalized as HookMessageProvider;
}

export function resolveHookDeliver(raw: unknown): boolean {
  return raw !== false;
}

export function normalizeAgentPayload(
  payload: Record<string, unknown>,
  opts?: { idFactory?: () => string },
):
  | {
      ok: true;
      value: HookAgentPayload;
    }
  | { ok: false; error: string } {
  const message =
    typeof payload.message === "string" ? payload.message.trim() : "";
  if (!message) return { ok: false, error: "message required" };
  const nameRaw = payload.name;
  const name =
    typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : "Hook";
  const wakeMode =
    payload.wakeMode === "next-heartbeat" ? "next-heartbeat" : "now";
  const sessionKeyRaw = payload.sessionKey;
  const idFactory = opts?.idFactory ?? randomUUID;
  const sessionKey =
    typeof sessionKeyRaw === "string" && sessionKeyRaw.trim()
      ? sessionKeyRaw.trim()
      : `hook:${idFactory()}`;
  const provider = resolveHookProvider(payload.provider);
  if (!provider) return { ok: false, error: HOOK_PROVIDER_ERROR };
  const toRaw = payload.to;
  const to =
    typeof toRaw === "string" && toRaw.trim() ? toRaw.trim() : undefined;
  const modelRaw = payload.model;
  const model =
    typeof modelRaw === "string" && modelRaw.trim()
      ? modelRaw.trim()
      : undefined;
  if (modelRaw !== undefined && !model) {
    return { ok: false, error: "model required" };
  }
  const deliver = resolveHookDeliver(payload.deliver);
  const thinkingRaw = payload.thinking;
  const thinking =
    typeof thinkingRaw === "string" && thinkingRaw.trim()
      ? thinkingRaw.trim()
      : undefined;
  const timeoutRaw = payload.timeoutSeconds;
  const timeoutSeconds =
    typeof timeoutRaw === "number" &&
    Number.isFinite(timeoutRaw) &&
    timeoutRaw > 0
      ? Math.floor(timeoutRaw)
      : undefined;
  return {
    ok: true,
    value: {
      message,
      name,
      wakeMode,
      sessionKey,
      deliver,
      provider,
      to,
      model,
      thinking,
      timeoutSeconds,
    },
  };
}
