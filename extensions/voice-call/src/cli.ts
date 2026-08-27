// Voice Call plugin module implements cli behavior.
import path from "node:path";
import type { Command } from "commander";
import { MAX_TCP_PORT } from "openclaw/plugin-sdk/number-runtime";
import {
  isRecord,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { registerVoiceCallLogs } from "./cli-call-log.js";
import { parseCliInteger, writeCliJson, writeCliLine } from "./cli-command-io.js";
import {
  callVoiceCallGateway,
  initiateVoiceCall,
  isUnknownMethod,
  pollContinueGateway,
  resolveContinueTimeout,
  resolveOperationTimeout,
  runGatewayManagerCommand,
} from "./cli-gateway-call.js";
import {
  resolveVoiceCallStreamExposurePaths,
  validateProviderConfig,
  type VoiceCallConfig,
} from "./config.js";
import { findCallMatchesInStore, loadActiveCallsFromStore } from "./manager/store.js";
import { setVoiceCallStateRuntime, type VoiceCallStateRuntime } from "./runtime-state.js";
import type { VoiceCallRuntime } from "./runtime.js";
import { resolveDefaultVoiceCallStoreDir } from "./store-path.js";
import { resolveUserPath } from "./utils.js";
import { resolveWebhookExposureStatus } from "./webhook-exposure.js";
import {
  cleanupTailscaleExposureRoute,
  getTailscaleSelfInfo,
  setupTailscaleExposureRoutes,
} from "./webhook/tailscale.js";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type SetupCheck = {
  id: string;
  ok: boolean;
  message: string;
};

type SetupStatus = {
  ok: boolean;
  checks: SetupCheck[];
};

function resolveMode(input: string): "off" | "serve" | "funnel" {
  const raw = normalizeOptionalLowercaseString(input) ?? "";
  if (raw === "serve" || raw === "off") {
    return raw;
  }
  return "funnel";
}

function resolveDefaultStorePath(config: VoiceCallConfig): string {
  const base = config.store?.trim()
    ? resolveUserPath(config.store)
    : resolveDefaultVoiceCallStoreDir();
  return path.join(base, "calls.jsonl");
}

function buildSetupStatus(config: VoiceCallConfig): SetupStatus {
  const validation = validateProviderConfig(config);
  const webhookExposure = resolveWebhookExposureStatus(config);
  const checks: SetupCheck[] = [
    {
      id: "plugin-enabled",
      ok: config.enabled,
      message: config.enabled
        ? "Voice Call plugin is enabled"
        : "Enable plugins.entries.voice-call.enabled",
    },
    {
      id: "provider",
      ok: Boolean(config.provider),
      message: config.provider
        ? `Provider configured: ${config.provider}`
        : "Set plugins.entries.voice-call.config.provider",
    },
    {
      id: "provider-config",
      ok: validation.valid,
      message: validation.valid
        ? "Provider credentials/config look complete"
        : validation.errors.join("; "),
    },
    {
      id: "webhook-exposure",
      ok: webhookExposure.ok,
      message: webhookExposure.message,
    },
    {
      id: "mode",
      ok: !(config.streaming.enabled && config.realtime.enabled),
      message:
        config.streaming.enabled && config.realtime.enabled
          ? "streaming.enabled and realtime.enabled cannot both be true"
          : config.realtime.enabled
            ? `Realtime voice enabled (${config.realtime.provider ?? "first registered provider"})`
            : config.streaming.enabled
              ? `Streaming transcription enabled (${config.streaming.provider ?? "first registered provider"})`
              : "Notify/conversation calls use normal TTS/STT flow",
    },
  ];
  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

function writeSetupStatus(status: SetupStatus): void {
  writeCliLine("Voice Call setup: %s", status.ok ? "OK" : "needs attention");
  for (const check of status.checks) {
    writeCliLine("%s %s: %s", check.ok ? "OK" : "FAIL", check.id, check.message);
  }
}

export function registerVoiceCallCli(params: {
  program: Command;
  config: VoiceCallConfig;
  ensureRuntime: () => Promise<VoiceCallRuntime>;
  stateRuntime?: VoiceCallStateRuntime["state"];
  logger: Logger;
}) {
  const { program, config, ensureRuntime, stateRuntime } = params;
  const ensureHistoryStateRuntime = (): void => {
    if (stateRuntime) {
      setVoiceCallStateRuntime({ state: stateRuntime });
    }
  };
  const root = program
    .command("voicecall")
    .description("Voice call utilities")
    .addHelpText("after", () => `\nDocs: https://docs.openclaw.ai/cli/voicecall\n`);

  root
    .command("setup")
    .description("Show Voice Call provider and webhook setup status")
    .option("--json", "Print machine-readable JSON")
    .action((options: { json?: boolean }) => {
      const status = buildSetupStatus(config);
      if (options.json) {
        writeCliJson(status);
        return;
      }
      writeSetupStatus(status);
    });

  root
    .command("smoke")
    .description("Check Voice Call readiness and optionally place a short outbound test call")
    .option("-t, --to <phone>", "Phone number to call for a live smoke")
    .option(
      "--message <text>",
      "Message to speak during the smoke call",
      "OpenClaw voice call smoke test.",
    )
    .option("--mode <mode>", "Call mode: notify or conversation", "notify")
    .option("--yes", "Actually place the live outbound call")
    .option("--json", "Print machine-readable JSON")
    .action(
      async (options: {
        to?: string;
        message?: string;
        mode?: string;
        yes?: boolean;
        json?: boolean;
      }) => {
        const setup = buildSetupStatus(config);
        if (!setup.ok) {
          if (options.json) {
            writeCliJson({ ok: false, setup });
          } else {
            writeSetupStatus(setup);
          }
          process.exitCode = 1;
          return;
        }
        if (!options.to) {
          if (options.json) {
            writeCliJson({ ok: true, setup, liveCall: false });
          } else {
            writeSetupStatus(setup);
            writeCliLine("live-call: skipped (pass --to and --yes to place one)");
          }
          return;
        }
        if (!options.yes) {
          if (options.json) {
            writeCliJson({ ok: true, setup, liveCall: false, wouldCall: options.to });
          } else {
            writeSetupStatus(setup);
            writeCliLine("live-call: dry run for %s (add --yes to place it)", options.to);
          }
          return;
        }
        const callId = await initiateVoiceCall({
          ensureRuntime,
          config,
          method: "voicecall.start",
          to: options.to,
          message: options.message,
          mode: options.mode,
          defaultMode: "notify",
          failureMessage: "smoke call failed",
        });
        if (options.json) {
          writeCliJson({ ok: true, setup, liveCall: true, callId });
          return;
        }
        writeSetupStatus(setup);
        writeCliLine("live-call: started %s", callId);
      },
    );

  root
    .command("call")
    .description("Initiate an outbound voice call")
    .requiredOption("-m, --message <text>", "Message to speak when call connects")
    .option(
      "-t, --to <phone>",
      "Phone number to call (E.164 format, uses config toNumber if not set)",
    )
    .option(
      "--mode <mode>",
      "Call mode: notify (hangup after message) or conversation (stay open)",
      "conversation",
    )
    .action(async (options: { message: string; to?: string; mode?: string }) => {
      const callId = await initiateVoiceCall({
        ensureRuntime,
        config,
        method: "voicecall.initiate",
        to: options.to,
        message: options.message,
        mode: options.mode,
      });
      writeCliJson({ callId });
    });

  root
    .command("start")
    .description("Alias for voicecall call")
    .requiredOption("--to <phone>", "Phone number to call")
    .option("--message <text>", "Message to speak when call connects")
    .option(
      "--mode <mode>",
      "Call mode: notify (hangup after message) or conversation (stay open)",
      "conversation",
    )
    .action(async (options: { to: string; message?: string; mode?: string }) => {
      const callId = await initiateVoiceCall({
        ensureRuntime,
        config,
        method: "voicecall.start",
        to: options.to,
        message: options.message,
        mode: options.mode,
      });
      writeCliJson({ callId });
    });

  root
    .command("continue")
    .description("Speak a message and wait for a response")
    .requiredOption("--call-id <id>", "Call ID")
    .requiredOption("--message <text>", "Message to speak")
    .action(async (options: { callId: string; message: string }) => {
      const gatewayParams = { callId: options.callId, message: options.message };
      const continueTimeoutMs = resolveContinueTimeout(config);
      await runGatewayManagerCommand({
        config,
        ensureRuntime,
        gatewayCall: async () => {
          try {
            return await callVoiceCallGateway("voicecall.continue.start", gatewayParams, {
              timeoutMs: resolveOperationTimeout(config),
            });
          } catch (err) {
            if (!isUnknownMethod(err, "voicecall.continue.start")) {
              throw err;
            }
            return callVoiceCallGateway("voicecall.continue", gatewayParams, {
              timeoutMs: continueTimeoutMs,
            });
          }
        },
        resolveGatewayPayload: (payload) => pollContinueGateway(payload, continueTimeoutMs),
        managerFallback: (manager) => manager.continueCall(options.callId, options.message),
        failureLabel: "continue",
      });
    });

  root
    .command("speak")
    .description("Speak a message without waiting for response")
    .requiredOption("--call-id <id>", "Call ID")
    .requiredOption("--message <text>", "Message to speak")
    .action(async (options: { callId: string; message: string }) => {
      await runGatewayManagerCommand({
        config,
        ensureRuntime,
        gatewayCall: () =>
          callVoiceCallGateway("voicecall.speak", {
            callId: options.callId,
            message: options.message,
          }),
        managerFallback: (manager) => manager.speak(options.callId, options.message),
        failureLabel: "speak",
      });
    });

  root
    .command("dtmf")
    .description("Send DTMF digits to an active call")
    .requiredOption("--call-id <id>", "Call ID")
    .requiredOption("--digits <digits>", "DTMF digits")
    .action(async (options: { callId: string; digits: string }) => {
      await runGatewayManagerCommand({
        config,
        ensureRuntime,
        gatewayCall: () =>
          callVoiceCallGateway("voicecall.dtmf", {
            callId: options.callId,
            digits: options.digits,
          }),
        managerFallback: (manager) => manager.sendDtmf(options.callId, options.digits),
        failureLabel: "dtmf",
      });
    });

  root
    .command("end")
    .description("Hang up an active call")
    .requiredOption("--call-id <id>", "Call ID")
    .action(async (options: { callId: string }) => {
      await runGatewayManagerCommand({
        config,
        ensureRuntime,
        gatewayCall: () => callVoiceCallGateway("voicecall.end", { callId: options.callId }),
        managerFallback: (manager) => manager.endCall(options.callId),
        failureLabel: "end",
      });
    });

  root
    .command("status")
    .description("Show call status")
    .option("--call-id <id>", "Call ID")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { callId?: string; json?: boolean }) => {
      const gateway = await callVoiceCallGateway(
        "voicecall.status",
        options.callId ? { callId: options.callId } : undefined,
      );
      if (gateway.ok) {
        if (options.callId && isRecord(gateway.payload)) {
          if (gateway.payload.found === true && "call" in gateway.payload) {
            writeCliJson(gateway.payload.call);
            return;
          }
          if (gateway.payload.found === false) {
            writeCliJson({ found: false });
            return;
          }
        }
        writeCliJson(gateway.payload);
        return;
      }
      // Status is a read-only command. Starting the telephony runtime here would
      // bind the webhook port and keep this one-shot CLI process alive.
      ensureHistoryStateRuntime();
      const storePath = path.dirname(resolveDefaultStorePath(config));
      if (options.callId) {
        const persisted = await findCallMatchesInStore(storePath, options.callId);
        const call = persisted.byCallId ?? persisted.byProviderCallId;
        writeCliJson(call ?? { found: false });
        return;
      }
      writeCliJson({
        found: true,
        calls: Array.from(loadActiveCallsFromStore(storePath).activeCalls.values()),
      });
    });

  registerVoiceCallLogs({
    root,
    defaultFile: resolveDefaultStorePath(config),
    ensureHistoryStateRuntime,
  });

  root
    .command("expose")
    .description("Enable/disable Tailscale serve/funnel for the webhook")
    .option("--mode <mode>", "off | serve (tailnet) | funnel (public)", "funnel")
    .option("--path <path>", "Tailscale path to expose (recommend matching serve.path)")
    .option("--port <port>", "Local webhook port")
    .option("--serve-path <path>", "Local webhook path")
    .action(
      async (options: { mode?: string; port?: string; path?: string; servePath?: string }) => {
        const mode = resolveMode(options.mode ?? "funnel");
        const servePort = parseCliInteger(
          options.port ?? String(config.serve.port ?? 3334),
          "--port",
          { min: 1, max: MAX_TCP_PORT },
        );
        const servePath = options.servePath ?? config.serve.path ?? "/voice/webhook";
        const tsPath = options.path ?? config.tailscale?.path ?? servePath;
        const streamExposurePaths = resolveVoiceCallStreamExposurePaths(config, {
          publicWebhookPath: tsPath,
          localWebhookPath: servePath,
        });
        const streamPaths = streamExposurePaths.map(({ publicPath }) => publicPath);
        const localUrl = `http://127.0.0.1:${servePort}${servePath}`;

        if (mode === "off") {
          for (const exposurePath of [tsPath, ...streamPaths]) {
            for (const tailscaleMode of ["serve", "funnel"] as const) {
              await cleanupTailscaleExposureRoute({
                mode: tailscaleMode,
                port: config.tailscale.port,
                path: exposurePath,
              });
            }
          }
          writeCliJson({ ok: true, mode: "off", path: tsPath, streamPaths });
          return;
        }

        const publicUrl = await setupTailscaleExposureRoutes({
          mode,
          port: config.tailscale.port,
          routes: [
            { path: tsPath, localUrl },
            ...streamExposurePaths.map(({ publicPath, localPath }) => ({
              path: publicPath,
              localUrl: `http://127.0.0.1:${servePort}${localPath}`,
            })),
          ],
        });

        const tsInfo = publicUrl ? null : await getTailscaleSelfInfo();
        const enableUrl = tsInfo?.nodeId
          ? `https://login.tailscale.com/f/${mode}?node=${tsInfo.nodeId}`
          : null;

        writeCliJson({
          ok: Boolean(publicUrl),
          mode,
          path: tsPath,
          streamPaths,
          localUrl,
          publicUrl,
          hint: publicUrl
            ? undefined
            : {
                note: "Tailscale serve/funnel may be disabled on this tailnet (or require admin enable).",
                enableUrl,
              },
        });
      },
    );
}
