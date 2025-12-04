import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSON5 from "json5";
import { z } from "zod";

import type { AgentKind } from "../agents/index.js";

export type ReplyMode = "text" | "command";
export type SessionScope = "per-sender" | "global";

export type SessionConfig = {
  scope?: SessionScope;
  resetTriggers?: string[];
  idleMinutes?: number;
  heartbeatIdleMinutes?: number;
  store?: string;
  sessionArgNew?: string[];
  sessionArgResume?: string[];
  sessionArgBeforeBody?: boolean;
  sendSystemOnce?: boolean;
  sessionIntro?: string;
  typingIntervalSeconds?: number;
  heartbeatMinutes?: number;
};

export type LoggingConfig = {
  level?: "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  file?: string;
};

export type WebReconnectConfig = {
  initialMs?: number;
  maxMs?: number;
  factor?: number;
  jitter?: number;
  maxAttempts?: number; // 0 = unlimited
};

export type WebConfig = {
  heartbeatSeconds?: number;
  reconnect?: WebReconnectConfig;
};

export type GroupChatConfig = {
  requireMention?: boolean;
  mentionPatterns?: string[];
  historyLimit?: number;
};

export type WarelayConfig = {
  logging?: LoggingConfig;
  inbound?: {
    allowFrom?: string[]; // E.164 numbers allowed to trigger auto-reply (without whatsapp:)
    messagePrefix?: string; // Prefix added to all inbound messages (default: "[warelay]" if no allowFrom, else "")
    responsePrefix?: string; // Prefix auto-added to all outbound replies (e.g., "🦞")
    timestampPrefix?: boolean | string; // true/false or IANA timezone string (default: true with UTC)
    transcribeAudio?: {
      // Optional CLI to turn inbound audio into text; templated args, must output transcript to stdout.
      command: string[];
      timeoutSeconds?: number;
    };
    groupChat?: GroupChatConfig;
    reply?: {
      mode: ReplyMode;
      text?: string;
      command?: string[];
      heartbeatCommand?: string[];
      thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high";
      verboseDefault?: "off" | "on";
      cwd?: string;
      template?: string;
      timeoutSeconds?: number;
      bodyPrefix?: string;
      mediaUrl?: string;
      session?: SessionConfig;
      mediaMaxMb?: number;
      typingIntervalSeconds?: number;
      heartbeatMinutes?: number;
      agent?: {
        kind: AgentKind;
        format?: "text" | "json";
        identityPrefix?: string;
      };
    };
  };
  web?: WebConfig;
};

// New branding path (preferred)
export const CONFIG_PATH_CLAWDIS = path.join(
  os.homedir(),
  ".clawdis",
  "clawdis.json",
);
// Legacy path (fallback for backward compatibility)
export const CONFIG_PATH_LEGACY = path.join(
  os.homedir(),
  ".warelay",
  "warelay.json",
);
// Deprecated: kept for backward compatibility
export const CONFIG_PATH = CONFIG_PATH_LEGACY;

/**
 * Resolve which config path to use.
 * Prefers new clawdis.json, falls back to warelay.json.
 */
function resolveConfigPath(): string {
  if (fs.existsSync(CONFIG_PATH_CLAWDIS)) {
    return CONFIG_PATH_CLAWDIS;
  }
  return CONFIG_PATH_LEGACY;
}

const ReplySchema = z
  .object({
    mode: z.union([z.literal("text"), z.literal("command")]),
    text: z.string().optional(),
    command: z.array(z.string()).optional(),
    heartbeatCommand: z.array(z.string()).optional(),
    thinkingDefault: z
      .union([
        z.literal("off"),
        z.literal("minimal"),
        z.literal("low"),
        z.literal("medium"),
        z.literal("high"),
      ])
      .optional(),
    verboseDefault: z.union([z.literal("off"), z.literal("on")]).optional(),
    cwd: z.string().optional(),
    template: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    bodyPrefix: z.string().optional(),
    mediaUrl: z.string().optional(),
    mediaMaxMb: z.number().positive().optional(),
    typingIntervalSeconds: z.number().int().positive().optional(),
    session: z
      .object({
        scope: z
          .union([z.literal("per-sender"), z.literal("global")])
          .optional(),
        resetTriggers: z.array(z.string()).optional(),
        idleMinutes: z.number().int().positive().optional(),
        heartbeatIdleMinutes: z.number().int().positive().optional(),
        store: z.string().optional(),
        sessionArgNew: z.array(z.string()).optional(),
        sessionArgResume: z.array(z.string()).optional(),
        sessionArgBeforeBody: z.boolean().optional(),
        sendSystemOnce: z.boolean().optional(),
        sessionIntro: z.string().optional(),
        typingIntervalSeconds: z.number().int().positive().optional(),
      })
      .optional(),
    heartbeatMinutes: z.number().int().nonnegative().optional(),
    agent: z
      .object({
        kind: z.union([
          z.literal("claude"),
          z.literal("opencode"),
          z.literal("pi"),
          z.literal("codex"),
          z.literal("gemini"),
        ]),
        format: z.union([z.literal("text"), z.literal("json")]).optional(),
        identityPrefix: z.string().optional(),
      })
      .optional(),
  })
  .refine(
    (val) =>
      val.mode === "text"
        ? Boolean(val.text)
        : Boolean(val.command || val.heartbeatCommand),
    {
      message:
        "reply.text is required for mode=text; reply.command or reply.heartbeatCommand is required for mode=command",
    },
  );

const WarelaySchema = z.object({
  logging: z
    .object({
      level: z
        .union([
          z.literal("silent"),
          z.literal("fatal"),
          z.literal("error"),
          z.literal("warn"),
          z.literal("info"),
          z.literal("debug"),
          z.literal("trace"),
        ])
        .optional(),
      file: z.string().optional(),
    })
    .optional(),
  inbound: z
    .object({
      allowFrom: z.array(z.string()).optional(),
      messagePrefix: z.string().optional(),
      responsePrefix: z.string().optional(),
      timestampPrefix: z.union([z.boolean(), z.string()]).optional(),
      groupChat: z
        .object({
          requireMention: z.boolean().optional(),
          mentionPatterns: z.array(z.string()).optional(),
          historyLimit: z.number().int().positive().optional(),
        })
        .optional(),
      transcribeAudio: z
        .object({
          command: z.array(z.string()),
          timeoutSeconds: z.number().int().positive().optional(),
        })
        .optional(),
      reply: ReplySchema.optional(),
    })
    .optional(),
  web: z
    .object({
      heartbeatSeconds: z.number().int().positive().optional(),
      reconnect: z
        .object({
          initialMs: z.number().positive().optional(),
          maxMs: z.number().positive().optional(),
          factor: z.number().positive().optional(),
          jitter: z.number().min(0).max(1).optional(),
          maxAttempts: z.number().int().min(0).optional(),
        })
        .optional(),
    })
    .optional(),
});

export function loadConfig(): WarelayConfig {
  // Read config file (JSON5) if present.
  // Prefers ~/.clawdis/clawdis.json, falls back to ~/.warelay/warelay.json
  const configPath = resolveConfigPath();
  try {
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON5.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const validated = WarelaySchema.safeParse(parsed);
    if (!validated.success) {
      console.error("Invalid config:");
      for (const iss of validated.error.issues) {
        console.error(`- ${iss.path.join(".")}: ${iss.message}`);
      }
      return {};
    }
    return validated.data as WarelayConfig;
  } catch (err) {
    console.error(`Failed to read config at ${configPath}`, err);
    return {};
  }
}
