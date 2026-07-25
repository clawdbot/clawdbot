import type { Command } from "commander";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import {
  addTimerTimeoutGraceMs,
  parseStrictNonNegativeInteger,
} from "openclaw/plugin-sdk/number-runtime";
import type { TeamsMeetingsConfig, TeamsMeetingsMode, TeamsMeetingsTransport } from "./config.js";
import { resolveTeamsMeetingsGatewayOperationTimeoutMs } from "./config.js";

type JoinOptions = {
  transport?: TeamsMeetingsTransport;
  mode?: TeamsMeetingsMode;
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

async function call(params: {
  config: TeamsMeetingsConfig;
  method: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const requestedTimeout =
    typeof params.payload?.timeoutMs === "number" ? params.payload.timeoutMs : undefined;
  const timeoutMs = Math.max(
    resolveTeamsMeetingsGatewayOperationTimeoutMs(params.config),
    requestedTimeout === undefined ? 0 : (addTimerTimeoutGraceMs(requestedTimeout, 30_000) ?? 1),
  );
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

export function registerTeamsMeetingsCli(params: {
  program: Command;
  config: TeamsMeetingsConfig;
}): void {
  const root = params.program
    .command("teamsmeetings")
    .description("Join and manage Microsoft Teams meeting guests");

  addJoinOptions(root.command("join <url>").description("join a Teams meeting as a guest")).action(
    async (url: string, options: JoinOptions) => {
      await call({
        config: params.config,
        method: "teamsmeetings.join",
        payload: joinPayload(url, options),
      });
    },
  );

  root
    .command("leave <session-id>")
    .description("leave a Teams meeting")
    .action(async (sessionId: string) => {
      await call({ config: params.config, method: "teamsmeetings.leave", payload: { sessionId } });
    });

  root
    .command("status [session-id]")
    .description("show Teams meeting session status")
    .action(async (sessionId?: string) => {
      await call({
        config: params.config,
        method: "teamsmeetings.status",
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
        method: "teamsmeetings.transcript",
        payload: { sessionId, ...(sinceIndex === undefined ? {} : { sinceIndex }) },
      });
    });

  root
    .command("speak <session-id> [message]")
    .description("speak through an active talk-back session")
    .action(async (sessionId: string, message?: string) => {
      await call({
        config: params.config,
        method: "teamsmeetings.speak",
        payload: { sessionId, ...(message ? { message } : {}) },
      });
    });

  root
    .command("setup")
    .description("check Teams meeting prerequisites")
    .option("--transport <transport>", "chrome or chrome-node")
    .option("--mode <mode>", "agent, bidi, or transcribe")
    .action(async (options: { transport?: TeamsMeetingsTransport; mode?: TeamsMeetingsMode }) => {
      await call({ config: params.config, method: "teamsmeetings.setup", payload: options });
    });

  for (const [name, method, description] of [
    ["test-speech", "teamsmeetings.testSpeech", "join and verify talk-back output"],
    [
      "test-listen",
      "teamsmeetings.testListen",
      "join in transcribe mode and report caption support",
    ],
  ] as const) {
    const command = root.command(`${name} <url>`).description(description);
    addProbeOptions(command).action(async (url: string, options: JoinOptions) => {
      await call({ config: params.config, method, payload: joinPayload(url, options) });
    });
  }
}
