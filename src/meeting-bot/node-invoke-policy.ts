import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyResult,
} from "../plugins/plugin-registration.types.js";
import type { MeetingAudioBackendSelection } from "./audio-backend.js";
import { isMeetingAudioBase64 } from "./audio-base64.js";
import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";

export type MeetingBrowserNodeStartConfig = {
  launch: boolean;
  browserProfile?: string;
  joinTimeoutMs: number;
  audioBackend?: MeetingAudioBackendSelection;
  audioBufferBytes?: number;
  audioFormat?: MeetingRealtimeAudioFormat;
  audioInputCommand?: string[];
  audioInputCommandOverride?: string[];
  audioOutputCommand?: string[];
  audioOutputCommandOverride?: string[];
  bargeInInputCommand?: string[];
  audioBridgeCommand?: string[];
  audioBridgeHealthCommand?: string[];
};

export type MeetingBrowserNodePolicyOptions = {
  commandName: string;
  displayName: string;
  deniedCode: string;
  supportedModes: ReadonlySet<string>;
  normalizeUrl(input: unknown): string;
  useConfiguredSetupCommands?: boolean;
  start: MeetingBrowserNodeStartConfig;
};

type PolicyDecision =
  | { approved: true; params: Record<string, unknown> }
  | { approved: false; result: OpenClawPluginNodeInvokePolicyResult };

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readOutputGeneration(value: unknown): number | undefined {
  return asSafeIntegerInRange(value, { min: 0 });
}

function copyCommand(command: string[] | undefined): string[] | undefined {
  return command && command.length > 0 ? [...command] : undefined;
}

function copyConfiguredAudio(
  target: Record<string, unknown>,
  start: MeetingBrowserNodeStartConfig,
): void {
  if (
    start.audioBackend === "auto" ||
    start.audioBackend === "blackhole-2ch" ||
    start.audioBackend === "pipewire-pulse"
  ) {
    target.audioBackend = start.audioBackend;
  }
  if (typeof start.audioBufferBytes === "number" && start.audioBufferBytes > 0) {
    target.audioBufferBytes = start.audioBufferBytes;
  }
  if (start.audioFormat === "pcm16-24khz" || start.audioFormat === "g711-ulaw-8khz") {
    target.audioFormat = start.audioFormat;
  }
  const hasCommandOverrideFields =
    "audioInputCommandOverride" in start || "audioOutputCommandOverride" in start;
  const audioInputCommand = copyCommand(
    start.audioInputCommandOverride ??
      (hasCommandOverrideFields ? undefined : start.audioInputCommand),
  );
  const audioOutputCommand = copyCommand(
    start.audioOutputCommandOverride ??
      (hasCommandOverrideFields ? undefined : start.audioOutputCommand),
  );
  if (audioInputCommand) {
    target.audioInputCommand = audioInputCommand;
  }
  if (audioOutputCommand) {
    target.audioOutputCommand = audioOutputCommand;
  }
  for (const key of [
    "bargeInInputCommand",
    "audioBridgeCommand",
    "audioBridgeHealthCommand",
  ] as const) {
    const command = copyCommand(start[key]);
    if (command) {
      target[key] = command;
    }
  }
}

function denied(options: MeetingBrowserNodePolicyOptions, message: string) {
  return { ok: false as const, code: options.deniedCode, message };
}

function approved(params: Record<string, unknown>): PolicyDecision {
  return { approved: true, params };
}

function buildStartParams(
  params: Record<string, unknown>,
  options: MeetingBrowserNodePolicyOptions,
): PolicyDecision {
  let url: string;
  try {
    url = options.normalizeUrl(params.url);
  } catch (error) {
    return {
      approved: false,
      result: denied(
        options,
        error instanceof Error ? error.message : `${options.commandName} start requires url`,
      ),
    };
  }
  const mode = readNonEmptyString(params.mode);
  if (mode && !options.supportedModes.has(mode)) {
    return {
      approved: false,
      result: denied(options, `${options.commandName} start mode is unsupported: ${mode}`),
    };
  }
  const startParams: Record<string, unknown> = {
    action: "start",
    url,
    launch: params.launch === false ? false : options.start.launch,
    browserProfile: options.start.browserProfile,
    joinTimeoutMs: options.start.joinTimeoutMs,
  };
  if (mode) {
    startParams.mode = mode;
  }
  copyConfiguredAudio(startParams, options.start);
  return approved(startParams);
}

function denyMissing(
  options: MeetingBrowserNodePolicyOptions,
  action: string,
  field: string,
): PolicyDecision {
  return {
    approved: false,
    result: denied(options, `${options.commandName} ${action} requires ${field}`),
  };
}

function buildForwardParams(
  params: Record<string, unknown>,
  options: MeetingBrowserNodePolicyOptions,
): PolicyDecision | null {
  const action = readNonEmptyString(params.action);
  switch (action) {
    case "setup":
      return approved({ action });
    case "status": {
      const bridgeId = readNonEmptyString(params.bridgeId);
      return approved(bridgeId ? { action, bridgeId } : { action });
    }
    case "list": {
      const forwarded: Record<string, unknown> = { action };
      const url = readNonEmptyString(params.url);
      const mode = readNonEmptyString(params.mode);
      if (url) {
        try {
          forwarded.url = options.normalizeUrl(url);
        } catch (error) {
          return {
            approved: false,
            result: denied(
              options,
              error instanceof Error ? error.message : `${options.commandName} list url`,
            ),
          };
        }
      }
      if (mode) {
        forwarded.mode = mode;
      }
      return approved(forwarded);
    }
    case "stopByUrl": {
      const forwarded: Record<string, unknown> = { action };
      const url = readNonEmptyString(params.url);
      const mode = readNonEmptyString(params.mode);
      const exceptBridgeId = readNonEmptyString(params.exceptBridgeId);
      if (!url) {
        return denyMissing(options, action, "url");
      }
      try {
        forwarded.url = options.normalizeUrl(url);
      } catch (error) {
        return {
          approved: false,
          result: denied(
            options,
            error instanceof Error ? error.message : `${options.commandName} stopByUrl url`,
          ),
        };
      }
      if (mode) {
        forwarded.mode = mode;
      }
      if (exceptBridgeId) {
        forwarded.exceptBridgeId = exceptBridgeId;
      }
      return approved(forwarded);
    }
    case "pullAudio": {
      const forwarded: Record<string, unknown> = { action };
      const bridgeId = readNonEmptyString(params.bridgeId);
      const timeoutMs = readPositiveNumber(params.timeoutMs);
      if (!bridgeId) {
        return denyMissing(options, action, "bridgeId");
      }
      forwarded.bridgeId = bridgeId;
      if (timeoutMs) {
        forwarded.timeoutMs = timeoutMs;
      }
      return approved(forwarded);
    }
    case "pushAudio": {
      const forwarded: Record<string, unknown> = { action };
      const bridgeId = readNonEmptyString(params.bridgeId);
      const base64 = readNonEmptyString(params.base64);
      if (!bridgeId) {
        return denyMissing(options, action, "bridgeId");
      }
      if (!base64) {
        return denyMissing(options, action, "base64");
      }
      if (!isMeetingAudioBase64(base64)) {
        return {
          approved: false,
          result: denied(options, "base64 must be a valid audio payload"),
        };
      }
      forwarded.bridgeId = bridgeId;
      forwarded.base64 = base64;
      const outputGeneration = readOutputGeneration(params.outputGeneration);
      if (params.outputGeneration !== undefined && outputGeneration === undefined) {
        return {
          approved: false,
          result: denied(options, "outputGeneration must be a non-negative safe integer"),
        };
      }
      if (outputGeneration !== undefined) {
        forwarded.outputGeneration = outputGeneration;
      }
      return approved(forwarded);
    }
    case "clearAudio": {
      const bridgeId = readNonEmptyString(params.bridgeId);
      if (!bridgeId) {
        return denyMissing(options, action, "bridgeId");
      }
      const outputGeneration = readOutputGeneration(params.outputGeneration);
      if (params.outputGeneration !== undefined && outputGeneration === undefined) {
        return {
          approved: false,
          result: denied(options, "outputGeneration must be a non-negative safe integer"),
        };
      }
      return approved({
        action,
        bridgeId,
        ...(outputGeneration !== undefined ? { outputGeneration } : {}),
      });
    }
    case "stop": {
      const bridgeId = readNonEmptyString(params.bridgeId);
      return approved(bridgeId ? { action, bridgeId } : { action });
    }
    default:
      return null;
  }
}

export function createMeetingBrowserNodeInvokePolicy(
  options: MeetingBrowserNodePolicyOptions,
): OpenClawPluginNodeInvokePolicy {
  return {
    commands: [options.commandName],
    dangerous: true,
    async handle(ctx) {
      if (ctx.command !== options.commandName) {
        return denied(options, `unsupported ${options.displayName} node command: ${ctx.command}`);
      }
      const params = asOptionalRecord(ctx.params) ?? {};
      const action = readNonEmptyString(params.action);
      if (action === "setup" && options.useConfiguredSetupCommands) {
        const setupParams: Record<string, unknown> = { action };
        copyConfiguredAudio(setupParams, options.start);
        return await ctx.invokeNode({ params: setupParams });
      }
      const decision =
        action === "start"
          ? buildStartParams(params, options)
          : (buildForwardParams(params, options) ?? {
              approved: false as const,
              result: denied(options, `unsupported ${options.commandName} action`),
            });
      if (!decision.approved) {
        return decision.result;
      }
      return await ctx.invokeNode({ params: decision.params });
    },
  };
}
