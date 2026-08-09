import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { resolveMeetingAudioRuntimeForFormat, type MeetingAudioRuntime } from "./audio-backend.js";
import { resolveMeetingBrowserNodeInfo } from "./browser-node.js";
import { isMeetingTalkBackMode } from "./meeting-modes.js";
import type { MeetingPluginConfig } from "./plugin-config.js";
import { addMeetingSetupCheck, createMeetingSetupStatus } from "./setup-checks.js";

type MeetingSetupNodeAdapter = {
  displayName: string;
  nodeCommandName: string;
  nodeConfigPath: string;
};

type MeetingRuntimeSetupOptions<Config extends MeetingPluginConfig, Mode extends string> = {
  assertAudioDeviceAvailable(params: {
    config: Config;
    runtime: PluginRuntime;
    timeoutMs: number;
  }): Promise<void>;
  captionsMessage(mode: Mode): string;
  connectedNodeMessage(nodeLabel: string | undefined): string;
  guestJoinCheck(config: Config): { message: string; ok: boolean };
  missingNodeIdMessage: string;
  nodeAdapter: MeetingSetupNodeAdapter;
};

async function commandExists(runtime: PluginRuntime, command: string): Promise<boolean> {
  const result = await runtime.system.runCommandWithTimeout(
    ["/bin/sh", "-lc", 'command -v "$1" >/dev/null 2>&1', "sh", command],
    { timeoutMs: 5_000 },
  );
  return result.code === 0;
}

export function createMeetingRuntimeSetup<Config extends MeetingPluginConfig, Mode extends string>(
  options: MeetingRuntimeSetupOptions<Config, Mode>,
) {
  return async (params: {
    config: Config;
    fullConfig: OpenClawConfig;
    runtime: PluginRuntime;
    options?: { mode?: Mode; transport?: "chrome" | "chrome-node" };
  }) => {
    const mode = params.options?.mode ?? (params.config.defaultMode as Mode);
    const transport =
      params.options?.transport ?? (params.config.chromeNode.node ? "chrome-node" : "chrome");
    const talkBack = isMeetingTalkBackMode(mode);
    const guestJoin = options.guestJoinCheck(params.config);
    let status = createMeetingSetupStatus([
      {
        id: "chrome-profile",
        ok: true,
        message: params.config.chrome.browserProfile
          ? `Chrome node profile configured: ${params.config.chrome.browserProfile}`
          : "Local Chrome uses the configured OpenClaw browser profile",
      },
      { id: "guest-join", ...guestJoin },
      { id: "captions", ok: true, message: options.captionsMessage(mode) },
    ]);

    if (transport === "chrome-node") {
      try {
        const node = await resolveMeetingBrowserNodeInfo({
          runtime: params.runtime,
          requestedNode: params.config.chromeNode.node,
          adapter: options.nodeAdapter,
        });
        status = addMeetingSetupCheck(status, {
          id: "chrome-node-connected",
          ok: true,
          message: options.connectedNodeMessage(node.displayName ?? node.remoteIp ?? node.nodeId),
        });
        if (talkBack) {
          if (!node.nodeId) {
            throw new Error(options.missingNodeIdMessage);
          }
          await params.runtime.nodes.invoke({
            nodeId: node.nodeId,
            command: options.nodeAdapter.nodeCommandName,
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
              ...(params.config.chrome.bargeInInputCommand
                ? { bargeInInputCommand: params.config.chrome.bargeInInputCommand }
                : {}),
            },
            timeoutMs: 12_000,
          });
          status = addMeetingSetupCheck(status, {
            id: "chrome-node-audio-prerequisites",
            ok: true,
            message: "Remote virtual audio backend and command-pair prerequisites are ready",
          });
        }
      } catch (error) {
        const connected = status.checks.some(
          (check) => check.id === "chrome-node-connected" && check.ok,
        );
        status = addMeetingSetupCheck(status, {
          id: connected ? "chrome-node-audio-prerequisites" : "chrome-node-connected",
          ok: false,
          message: formatErrorMessage(error),
        });
      }
    }

    if (!talkBack) {
      return status;
    }
    status = addMeetingSetupCheck(status, {
      id: "audio-bridge",
      ok: true,
      message: `Command-pair audio bridge configured (${params.config.chrome.audioFormat})`,
    });
    if (transport === "chrome-node") {
      return status;
    }
    let audio: MeetingAudioRuntime | undefined;
    try {
      audio = resolveMeetingAudioRuntimeForFormat({
        backend: params.config.chrome.audioBackend,
        bufferBytes: params.config.chrome.audioBufferBytes,
        format: params.config.chrome.audioFormat,
        inputCommand: params.config.chrome.audioInputCommandOverride,
        outputCommand: params.config.chrome.audioOutputCommandOverride,
      });
      await options.assertAudioDeviceAvailable({
        config: params.config,
        runtime: params.runtime,
        timeoutMs: Math.min(params.config.chrome.joinTimeoutMs, 10_000),
      });
      status = addMeetingSetupCheck(status, {
        id: "chrome-local-audio-device",
        ok: true,
        message: "Virtual meeting audio backend is ready",
      });
    } catch (error) {
      status = addMeetingSetupCheck(status, {
        id: "chrome-local-audio-device",
        ok: false,
        message: formatErrorMessage(error),
      });
      if (!audio) {
        return status;
      }
    }
    const commands = uniqueStrings(
      [
        audio.inputCommand[0],
        audio.outputCommand[0],
        params.config.chrome.bargeInInputCommand?.[0],
      ].filter((value): value is string => Boolean(value?.trim())),
    );
    const missing: string[] = [];
    for (const command of commands) {
      if (!(await commandExists(params.runtime, command).catch(() => false))) {
        missing.push(command);
      }
    }
    return addMeetingSetupCheck(status, {
      id: "chrome-local-audio-commands",
      ok: missing.length === 0,
      message:
        missing.length === 0
          ? "Configured Chrome audio commands are available"
          : `Chrome audio commands missing: ${missing.join(", ")}`,
    });
  };
}
