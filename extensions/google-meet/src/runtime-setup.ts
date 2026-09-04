import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GoogleMeetConfig, GoogleMeetModeInput, GoogleMeetTransport } from "./config.js";
import { addGoogleMeetSetupCheck, getGoogleMeetSetupStatus } from "./setup.js";
import { resolveChromeNodeInfo } from "./transports/chrome-browser-proxy.js";
import { assertGoogleMeetAudioAvailable } from "./transports/chrome.js";
import { GOOGLE_MEET_NODE_COMMAND } from "./transports/google-meet-platform-constants.js";
import { normalizeDialInNumber } from "./transports/twilio.js";

function collectChromeAudioCommands(config: GoogleMeetConfig): string[] {
  const commands = config.chrome.audioBridgeCommand
    ? [config.chrome.audioBridgeCommand[0]]
    : [
        config.chrome.audioInputCommand?.[0],
        config.chrome.audioOutputCommand?.[0],
        config.chrome.bargeInInputCommand?.[0],
      ];
  return uniqueStrings(commands.filter((value): value is string => Boolean(value?.trim())));
}

async function commandExists(runtime: PluginRuntime, command: string): Promise<boolean> {
  const result = await runtime.system.runCommandWithTimeout(
    ["/bin/sh", "-lc", 'command -v "$1" >/dev/null 2>&1', "sh", command],
    { timeoutMs: 5_000 },
  );
  return result.code === 0;
}

export async function getGoogleMeetRuntimeSetupStatus(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  options?: {
    transport?: GoogleMeetTransport;
    mode?: GoogleMeetModeInput;
    dialInNumber?: string;
  };
}) {
  const options = params.options ?? {};
  const transport = options.transport ?? params.config.defaultTransport;
  const mode = options.mode === "realtime" ? "agent" : (options.mode ?? params.config.defaultMode);
  const twilioDialInNumber =
    transport === "twilio" ? normalizeDialInNumber(options.dialInNumber) : undefined;
  const shouldCheckChromeNode =
    transport === "chrome-node" || (!options.transport && Boolean(params.config.chromeNode.node));
  let status = getGoogleMeetSetupStatus(params.config, {
    fullConfig: params.fullConfig,
    mode,
    transport,
    twilioDialInNumber,
  });
  if (shouldCheckChromeNode) {
    try {
      const node = await resolveChromeNodeInfo({
        runtime: params.runtime,
        requestedNode: params.config.chromeNode.node,
      });
      const label = node.displayName ?? node.remoteIp ?? node.nodeId ?? "connected node";
      status = addGoogleMeetSetupCheck(status, {
        id: "chrome-node-connected",
        ok: true,
        message: `Connected Google Meet node ready: ${label}`,
      });
      if ((mode === "agent" || mode === "bidi") && node.nodeId) {
        const setup = await params.runtime.nodes.invoke({
          nodeId: node.nodeId,
          command: GOOGLE_MEET_NODE_COMMAND,
          params: {
            action: "setup",
            audioBackend: params.config.chrome.audioBackend,
            audioFormat: params.config.chrome.audioFormat,
            audioBufferBytes: params.config.chrome.audioBufferBytes,
            ...(params.config.chrome.audioInputCommandOverride
              ? { audioInputCommand: params.config.chrome.audioInputCommandOverride }
              : {}),
            ...(params.config.chrome.audioOutputCommandOverride
              ? { audioOutputCommand: params.config.chrome.audioOutputCommandOverride }
              : {}),
          },
          timeoutMs: 12_000,
        });
        status = addGoogleMeetSetupCheck(status, {
          id: "chrome-node-audio-prerequisites",
          ok: true,
          message: setup
            ? "Remote virtual audio backend and command-pair prerequisites are ready"
            : "Remote audio setup completed",
        });
      }
    } catch (error) {
      status = addGoogleMeetSetupCheck(status, {
        id: "chrome-node-connected",
        ok: false,
        message: formatErrorMessage(error),
      });
    }
  }
  if (transport !== "chrome" || (mode !== "agent" && mode !== "bidi")) {
    return status;
  }
  try {
    await assertGoogleMeetAudioAvailable({
      runtime: params.runtime,
      config: params.config,
      timeoutMs: Math.min(params.config.chrome.joinTimeoutMs, 10_000),
    });
    status = addGoogleMeetSetupCheck(status, {
      id: "chrome-local-audio-device",
      ok: true,
      message: "Virtual meeting audio backend is ready",
    });
  } catch (error) {
    status = addGoogleMeetSetupCheck(status, {
      id: "chrome-local-audio-device",
      ok: false,
      message: formatErrorMessage(error),
    });
  }
  const commands = collectChromeAudioCommands(params.config);
  const missingCommands: string[] = [];
  for (const command of commands) {
    try {
      if (!(await commandExists(params.runtime, command))) {
        missingCommands.push(command);
      }
    } catch {
      missingCommands.push(command);
    }
  }
  return addGoogleMeetSetupCheck(status, {
    id: "chrome-local-audio-commands",
    ok: commands.length > 0 && missingCommands.length === 0,
    message:
      commands.length === 0
        ? "Chrome talk-back audio commands are not configured"
        : missingCommands.length === 0
          ? `Chrome audio command${commands.length === 1 ? "" : "s"} available: ${commands.join(", ")}`
          : `Chrome audio command${missingCommands.length === 1 ? "" : "s"} missing: ${missingCommands.join(", ")}`,
  });
}
