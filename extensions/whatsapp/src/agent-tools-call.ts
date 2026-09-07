// WhatsApp plugin tool places requester-bound calls through the MeowCaller companion CLI.
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import { createActionGate, stringEnum } from "openclaw/plugin-sdk/channel-actions";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { mulawToPcm } from "openclaw/plugin-sdk/realtime-voice";
import { detectBinary } from "openclaw/plugin-sdk/setup-tools";
import { resolveOAuthDir } from "openclaw/plugin-sdk/state-paths";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { resolveWhatsAppAccount } from "./accounts.js";
import { getWhatsAppConnectionController } from "./connection-controller-runtime-context.js";
import { resolveJidToE164 } from "./targets-runtime.js";

const MEOWCALLER_COMMAND = "meowcaller";
const SESSION_DATABASE = "wa-voip.db";
const MEOWCALLER_CONNECT_TIMEOUT_MS = 60_000;
const MEOWCALLER_ANSWER_TIMEOUT_MS = 45_000;
const CALL_SHUTDOWN_GRACE_MS = 10_000;
const MAX_AUDIO_DURATION_MS = 60_000;
const MIN_CALL_WINDOW_MS =
  MEOWCALLER_CONNECT_TIMEOUT_MS + MEOWCALLER_ANSWER_TIMEOUT_MS + CALL_SHUTDOWN_GRACE_MS;
const MAX_CALL_WINDOW_MS = MIN_CALL_WINDOW_MS + MAX_AUDIO_DURATION_MS;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MEOWCALLER_ANSWER_TIMEOUT = "45s";
const MEOWCALLER_MAX_DURATION = "65s";

// One whatsmeow session database must not be driven by concurrent companion clients.
// Reject overlap so model retries cannot duplicate calls or contend on auth state.
const activeCallAccounts = new Set<string>();

const WhatsAppCallToolSchema = Type.Object(
  {
    action: stringEnum(["status", "call"] as const, {
      description: "Check MeowCaller setup or call the current WhatsApp requester",
    }),
    message: Type.Optional(
      Type.String({
        description: "Spoken message to play after the requester answers (maximum 60 seconds)",
        maxLength: MAX_MESSAGE_LENGTH,
      }),
    ),
  },
  { additionalProperties: false },
);

type WhatsAppCallToolParams = {
  action: "status" | "call";
  message?: string;
};

type WhatsAppCallToolDependencies = {
  detectMeowCaller: () => Promise<boolean>;
  resolveStateDir: (accountId: string) => string;
};

const defaultDependencies: WhatsAppCallToolDependencies = {
  detectMeowCaller: () => detectBinary(MEOWCALLER_COMMAND),
  resolveStateDir: (accountId) =>
    path.join(resolveOAuthDir(), "whatsapp-calls", normalizeAccountId(accountId)),
};

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quotePowerShellArg(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function resolveSetupCommand(
  stateDir: string,
  sessionStorePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return `meowcaller pair --store ${quotePowerShellArg(sessionStorePath)}`;
  }
  const quotedStateDir = quotePosixShellArg(stateDir);
  const quotedStorePath = quotePosixShellArg(sessionStorePath);
  return `mkdir -p ${quotedStateDir} && chmod 700 ${quotedStateDir} && meowcaller pair --store ${quotedStorePath}`;
}

function wrapPcm16MonoInWav(pcm: Buffer, sampleRate: number): Buffer {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error("TTS returned an invalid sample rate");
  }
  if (pcm.length === 0 || pcm.length % 2 !== 0) {
    throw new Error("TTS returned invalid 16-bit PCM audio");
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function normalizeTelephonyPcm(audio: Buffer, outputFormat: string | undefined): Buffer {
  const normalizedFormat = outputFormat?.trim().toLowerCase();
  if (normalizedFormat?.startsWith("pcm")) {
    return audio;
  }
  if (normalizedFormat === "ulaw_8000" || normalizedFormat === "raw-8khz-8bit-mono-mulaw") {
    return mulawToPcm(audio);
  }
  throw new Error(`TTS returned unsupported telephony format: ${outputFormat ?? "unknown"}`);
}

function resolveCallWindowMs(pcmBytes: number, sampleRate: number): number {
  const audioDurationMs = (pcmBytes / 2 / sampleRate) * 1_000;
  if (audioDurationMs > MAX_AUDIO_DURATION_MS) {
    throw new Error("TTS audio exceeds the 60-second WhatsApp call limit");
  }
  return Math.min(MAX_CALL_WINDOW_MS, Math.ceil(audioDurationMs + MIN_CALL_WINDOW_MS));
}

async function resolveRequesterE164(params: {
  accountId: string;
  cfg: NonNullable<OpenClawPluginToolContext["config"]>;
  requesterSenderId: string;
}): Promise<string | null> {
  const senderId = params.requesterSenderId.trim();
  if (!senderId.includes("@")) {
    try {
      return normalizeE164(senderId.replace(/^whatsapp:/i, ""));
    } catch {
      return null;
    }
  }

  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId });
  const lidLookup = getWhatsAppConnectionController(params.accountId)?.getCurrentSock()
    ?.signalRepository.lidMapping;
  return await resolveJidToE164(senderId, { authDir: account.authDir, lidLookup });
}

async function resolveLinkedWhatsAppSelfE164(params: {
  accountId: string;
  cfg: NonNullable<OpenClawPluginToolContext["config"]>;
}): Promise<string | null> {
  const controller = getWhatsAppConnectionController(params.accountId);
  if (!controller) {
    return null;
  }
  const identity = controller.getSelfIdentity();
  if (!identity) {
    return null;
  }
  if (identity.e164) {
    return normalizeE164(identity.e164);
  }
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId });
  const lidLookup = controller.getCurrentSock()?.signalRepository.lidMapping;
  return await resolveJidToE164(identity.jid ?? identity.lid, {
    authDir: account.authDir,
    lidLookup,
  });
}

function resolveRuntimeConfig(api: OpenClawPluginApi, context: OpenClawPluginToolContext) {
  return context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config ?? api.config;
}

function createWhatsAppCallToolWithDependencies(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
  dependencies: WhatsAppCallToolDependencies,
): AnyAgentTool | null {
  const cfg = resolveRuntimeConfig(api, context);
  const isActionEnabled = createActionGate(cfg.channels?.whatsapp?.actions);
  const requesterSenderId = context.requesterSenderId?.trim();
  if (
    !isActionEnabled("calls", false) ||
    context.messageChannel !== "whatsapp" ||
    !requesterSenderId
  ) {
    return null;
  }

  const accountId = normalizeAccountId(context.agentAccountId);
  const stateDir = dependencies.resolveStateDir(accountId);
  const sessionStorePath = path.join(stateDir, SESSION_DATABASE);

  return {
    name: "whatsapp_call",
    label: "WhatsApp Call",
    description:
      "Call the current WhatsApp requester and play a synthesized spoken message. This tool cannot call arbitrary phone numbers.",
    parameters: WhatsAppCallToolSchema,
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as WhatsAppCallToolParams;
      const binaryFound = await dependencies.detectMeowCaller();
      const sessionStoreFound = await isRegularFile(sessionStorePath);
      if (params.action === "status") {
        return jsonResult({
          binaryFound,
          sessionStoreFound,
          accountId,
          stateDir,
          setupCommand: resolveSetupCommand(stateDir, sessionStorePath),
          setupShell: process.platform === "win32" ? "PowerShell" : "POSIX shell",
          requiredCommand:
            "meowcaller notify --store <path> --answer-timeout 45s --max-duration 65s <target> <file>",
          note: "MeowCaller uses a separate WhatsApp linked-device session; it cannot reuse OpenClaw's Baileys credentials.",
        });
      }

      const message = params.message?.trim();
      if (!message) {
        throw new Error("message required for call action");
      }
      if (message.length > MAX_MESSAGE_LENGTH) {
        throw new Error(`message must be at most ${MAX_MESSAGE_LENGTH} characters`);
      }
      if (!binaryFound) {
        throw new Error("MeowCaller is not installed; run whatsapp_call with action=status");
      }
      if (!sessionStoreFound) {
        throw new Error(
          "MeowCaller has no session store; run whatsapp_call with action=status, then run its setupCommand in an interactive terminal and scan the QR as a linked device",
        );
      }

      const target = await resolveRequesterE164({
        accountId,
        cfg,
        requesterSenderId,
      });
      if (!target) {
        throw new Error("Could not resolve the current WhatsApp requester to a phone number");
      }
      const linkedSelf = await resolveLinkedWhatsAppSelfE164({ accountId, cfg });
      if (linkedSelf === target) {
        throw new Error(
          "WhatsApp cannot call the linked account itself; use a dedicated OpenClaw WhatsApp number",
        );
      }

      if (activeCallAccounts.has(accountId)) {
        throw new Error("A WhatsApp call is already active for this account");
      }
      activeCallAccounts.add(accountId);
      try {
        const speech = await api.runtime.tts.textToSpeechTelephony({ text: message, cfg });
        if (!speech.success || !speech.audioBuffer || !speech.sampleRate) {
          throw new Error(speech.error ?? "TTS synthesis failed");
        }
        const pcm = normalizeTelephonyPcm(speech.audioBuffer, speech.outputFormat);
        const callWindowMs = resolveCallWindowMs(pcm.length, speech.sampleRate);
        const tempDir = await fs.mkdtemp(
          path.join(resolvePreferredOpenClawTmpDir(), "openclaw-whatsapp-call-"),
        );
        const audioPath = path.join(tempDir, "message.wav");
        try {
          await fs.writeFile(audioPath, wrapPcm16MonoInWav(pcm, speech.sampleRate), {
            mode: 0o600,
          });
          const result = await api.runtime.system.runCommandWithTimeout(
            [
              MEOWCALLER_COMMAND,
              "notify",
              "--store",
              sessionStorePath,
              "--answer-timeout",
              MEOWCALLER_ANSWER_TIMEOUT,
              "--max-duration",
              MEOWCALLER_MAX_DURATION,
              target,
              audioPath,
            ],
            {
              cwd: stateDir,
              env: { MEOW_LOG_LEVEL: "warn" },
              timeoutMs: callWindowMs,
              signal,
              killProcessTree: true,
              maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
            },
          );
          if (result.termination === "signal") {
            throw new Error("WhatsApp call cancelled");
          }
          if (result.termination === "timeout") {
            throw new Error("MeowCaller exceeded the bounded WhatsApp call window");
          }
          if (result.termination !== "exit" || result.code !== 0) {
            throw new Error(
              `MeowCaller did not complete the call (code ${result.code ?? "unknown"})`,
            );
          }
          return jsonResult({
            completed: true,
            recipient: "current WhatsApp requester",
            callWindowSeconds: Math.ceil(callWindowMs / 1_000),
            ttsProvider: speech.provider,
            note: "MeowCaller completed answer, playback, and hangup for the requester-bound call.",
          });
        } finally {
          await fs.rm(tempDir, { recursive: true, force: true });
        }
      } finally {
        activeCallAccounts.delete(accountId);
      }
    },
  };
}

function createWhatsAppCallTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): AnyAgentTool | null {
  return createWhatsAppCallToolWithDependencies(api, context, defaultDependencies);
}

export function registerWhatsAppCallTool(api: OpenClawPluginApi): void {
  api.registerTool((context) => createWhatsAppCallTool(api, context), {
    name: "whatsapp_call",
  });
}
