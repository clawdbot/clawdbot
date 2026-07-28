import type { Command } from "commander";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import {
  addTimerTimeoutGraceMs,
  parseStrictNonNegativeInteger,
} from "openclaw/plugin-sdk/number-runtime";
import type { ZoomMeetingsConfig, ZoomMeetingsMode, ZoomMeetingsTransport } from "./config.js";
import { resolveZoomMeetingsGatewayOperationTimeoutMs } from "./config.js";
import { resolveZoomMeetingsProbeTimeoutMs } from "./probe-timeout.js";

type JoinOptions = {
  transport?: ZoomMeetingsTransport;
  mode?: ZoomMeetingsMode;
  message?: string;
  timeoutMs?: string;
};

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseStrictNonNegativeInteger(value);
  if (parsed === undefined || parsed === 0) {
    throw new Error("timeout-ms must be a positive integer");
  }
  return parsed;
}

export function resolveZoomMeetingsCliGatewayTimeoutMs(
  config: ZoomMeetingsConfig,
  options: { probe: boolean; requestedTimeoutMs?: number },
): number {
  const operationTimeoutMs = resolveZoomMeetingsGatewayOperationTimeoutMs(config);
  const probeTimeoutMs = options.probe
    ? resolveZoomMeetingsProbeTimeoutMs(options.requestedTimeoutMs, config.chrome.joinTimeoutMs)
    : undefined;
  return probeTimeoutMs === undefined
    ? operationTimeoutMs
    : (addTimerTimeoutGraceMs(operationTimeoutMs, probeTimeoutMs) ?? 1);
}

async function call(params: {
  config: ZoomMeetingsConfig;
  method: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const requestedTimeout =
    typeof params.payload?.timeoutMs === "number" ? params.payload.timeoutMs : undefined;
  const timeoutMs = resolveZoomMeetingsCliGatewayTimeoutMs(params.config, {
    probe:
      params.method === "zoommeetings.testSpeech" || params.method === "zoommeetings.testListen",
    requestedTimeoutMs: requestedTimeout,
  });
  print(
    await callGatewayFromCli(
      params.method,
      {
        json: true,
        timeout: String(timeoutMs),
      },
      params.payload,
      { progress: false, scopes: ["operator.admin"] },
    ),
  );
}

function joinPayload(url: string, options: JoinOptions): Record<string, unknown> {
  return {
    url,
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.message ? { message: options.message } : {}),
    ...(options.timeoutMs ? { timeoutMs: parseTimeout(options.timeoutMs) } : {}),
  };
}

function addJoinOptions(command: Command): Command {
  return command
    .option("--transport <transport>", "chrome or chrome-node")
    .option("--mode <mode>", "agent, bidi, or transcribe")
    .option("--message <text>", "instructions to speak after joining");
}

function addProbeOptions(command: Command): Command {
  return addJoinOptions(command).option("--timeout-ms <ms>", "probe timeout in milliseconds");
}

export function registerZoomMeetingsCli(params: {
  program: Command;
  config: ZoomMeetingsConfig;
}): void {
  const root = params.program
    .command("zoommeetings")
    .description("Join and manage Zoom meeting guests");

  addJoinOptions(root.command("join <url>").description("join a Zoom meeting as a guest")).action(
    async (url: string, options: JoinOptions) => {
      await call({
        config: params.config,
        method: "zoommeetings.join",
        payload: joinPayload(url, options),
      });
    },
  );

  root
    .command("leave <session-id>")
    .description("leave a Zoom meeting")
    .action(async (sessionId: string) => {
      await call({ config: params.config, method: "zoommeetings.leave", payload: { sessionId } });
    });

  root
    .command("status [session-id]")
    .description("show Zoom meeting session status")
    .action(async (sessionId?: string) => {
      await call({
        config: params.config,
        method: "zoommeetings.status",
        payload: sessionId ? { sessionId } : {},
      });
    });

  root
    .command("transcript <session-id>")
    .description("read the current transcript snapshot")
    .option("--since-index <index>", "resume from a prior transcript index")
    .action(async (sessionId: string, options: { sinceIndex?: string }) => {
      const sinceIndex =
        options.sinceIndex === undefined
          ? undefined
          : parseStrictNonNegativeInteger(options.sinceIndex);
      if (options.sinceIndex !== undefined && sinceIndex === undefined) {
        throw new Error("since-index must be a non-negative integer");
      }
      await call({
        config: params.config,
        method: "zoommeetings.transcript",
        payload: { sessionId, ...(sinceIndex === undefined ? {} : { sinceIndex }) },
      });
    });

  root
    .command("speak <session-id> [message]")
    .description("speak through an active talk-back session")
    .action(async (sessionId: string, message?: string) => {
      await call({
        config: params.config,
        method: "zoommeetings.speak",
        payload: { sessionId, ...(message ? { message } : {}) },
      });
    });

  root
    .command("setup")
    .description("check Zoom meeting prerequisites")
    .option("--transport <transport>", "chrome or chrome-node")
    .option("--mode <mode>", "agent, bidi, or transcribe")
    .action(async (options: { transport?: ZoomMeetingsTransport; mode?: ZoomMeetingsMode }) => {
      await call({ config: params.config, method: "zoommeetings.setup", payload: options });
    });

  for (const [name, method, description] of [
    ["test-speech", "zoommeetings.testSpeech", "join and verify talk-back output"],
    [
      "test-listen",
      "zoommeetings.testListen",
      "join in transcribe mode and report caption support",
    ],
  ] as const) {
    const command = root.command(`${name} <url>`).description(description);
    addProbeOptions(command).action(async (url: string, options: JoinOptions) => {
      await call({ config: params.config, method, payload: joinPayload(url, options) });
    });
  }
}
