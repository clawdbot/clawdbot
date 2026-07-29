import type {
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyResult,
} from "../plugins/plugin-registration.types.js";
import { isMeetingAudioBase64 } from "./audio-base64.js";

export type MeetingBrowserNodeStartConfig = {
  launch: boolean;
  browserProfile?: string;
  joinTimeoutMs: number;
  audioInputCommand?: string[];
  audioOutputCommand?: string[];
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function copyCommand(command: string[] | undefined): string[] | undefined {
  return command && command.length > 0 ? [...command] : undefined;
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
  const mode = readString(params.mode);
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
  for (const key of [
    "audioInputCommand",
    "audioOutputCommand",
    "audioBridgeCommand",
    "audioBridgeHealthCommand",
  ] as const) {
    const command = copyCommand(options.start[key]);
    if (command) {
      startParams[key] = command;
    }
  }
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
  const action = readString(params.action);
  switch (action) {
    case "setup":
      return approved({ action });
    case "status": {
      const bridgeId = readString(params.bridgeId);
      return approved(bridgeId ? { action, bridgeId } : { action });
    }
    case "list": {
      const forwarded: Record<string, unknown> = { action };
      const url = readString(params.url);
      const mode = readString(params.mode);
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
      const url = readString(params.url);
      const mode = readString(params.mode);
      const exceptBridgeId = readString(params.exceptBridgeId);
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
      const bridgeId = readString(params.bridgeId);
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
      const bridgeId = readString(params.bridgeId);
      const base64 = readString(params.base64);
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
      return approved(forwarded);
    }
    case "clearAudio": {
      const bridgeId = readString(params.bridgeId);
      return bridgeId ? approved({ action, bridgeId }) : denyMissing(options, action, "bridgeId");
    }
    case "stop": {
      const bridgeId = readString(params.bridgeId);
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
      const params = asRecord(ctx.params);
      const action = readString(params.action);
      if (action === "setup" && options.useConfiguredSetupCommands) {
        const setupParams: Record<string, unknown> = { action };
        for (const key of [
          "audioInputCommand",
          "audioOutputCommand",
          "bargeInInputCommand",
        ] as const) {
          const command = copyCommand(options.start[key]);
          if (command) {
            setupParams[key] = command;
          }
        }
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
