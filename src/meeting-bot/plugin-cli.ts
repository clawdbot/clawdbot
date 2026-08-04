import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import type { Command } from "commander";
import type { callGatewayFromCli } from "../cli/gateway-rpc.js";
import type { MeetingPluginConfig } from "./plugin-config.js";

type MeetingCliMode = "agent" | "bidi" | "transcribe";
type MeetingCliTransport = "chrome" | "chrome-node";

type MeetingCliDescriptions = {
  root: string;
  join: string;
  leave: string;
  status: string;
  setup: string;
  testSpeech: string;
  testListen: string;
};

type MeetingCliOptions = {
  callGateway: typeof callGatewayFromCli;
  commandName: string;
  config: MeetingPluginConfig;
  descriptions: MeetingCliDescriptions;
  methodPrefix: string;
  program: Command;
  resolveGatewayTimeoutMs(params: {
    config: MeetingPluginConfig;
    method: string;
    requestedTimeoutMs?: number;
  }): number;
};

type JoinOptions = {
  transport?: MeetingCliTransport;
  mode?: MeetingCliMode;
  message?: string;
  timeoutMs?: string;
};

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

export function registerMeetingPluginCli(options: MeetingCliOptions): void {
  const call = async (method: string, payload?: Record<string, unknown>) => {
    const requestedTimeoutMs =
      typeof payload?.timeoutMs === "number" ? payload.timeoutMs : undefined;
    const timeoutMs = options.resolveGatewayTimeoutMs({
      config: options.config,
      method,
      requestedTimeoutMs,
    });
    const result = await options.callGateway(
      method,
      { json: true, timeout: String(timeoutMs) },
      payload,
      { progress: false, scopes: ["operator.admin"] },
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  };
  const method = (action: string) => `${options.methodPrefix}.${action}`;
  const root = options.program.command(options.commandName).description(options.descriptions.root);
  const command = (usage: string, description: string) =>
    root.command(usage).description(description);

  addJoinOptions(command("join <url>", options.descriptions.join)).action(
    async (url: string, joinOptions: JoinOptions) => {
      await call(method("join"), joinPayload(url, joinOptions));
    },
  );
  command("leave <session-id>", options.descriptions.leave).action(async (sessionId: string) => {
    await call(method("leave"), { sessionId });
  });
  command("status [session-id]", options.descriptions.status).action(async (sessionId?: string) => {
    await call(method("status"), sessionId ? { sessionId } : {});
  });
  command("transcript <session-id>", "read the current transcript snapshot")
    .option("--since-index <index>", "resume from a prior transcript index")
    .action(async (sessionId: string, transcriptOptions: { sinceIndex?: string }) => {
      const sinceIndex =
        transcriptOptions.sinceIndex === undefined
          ? undefined
          : parseStrictNonNegativeInteger(transcriptOptions.sinceIndex);
      if (transcriptOptions.sinceIndex !== undefined && sinceIndex === undefined) {
        throw new Error("since-index must be a non-negative integer");
      }
      await call(method("transcript"), {
        sessionId,
        ...(sinceIndex === undefined ? {} : { sinceIndex }),
      });
    });
  command("speak <session-id> [message]", "speak through an active talk-back session").action(
    async (sessionId: string, message?: string) => {
      await call(method("speak"), { sessionId, ...(message ? { message } : {}) });
    },
  );
  command("setup", options.descriptions.setup)
    .option("--transport <transport>", "chrome or chrome-node")
    .option("--mode <mode>", "agent, bidi, or transcribe")
    .action(async (setupOptions: { transport?: MeetingCliTransport; mode?: MeetingCliMode }) => {
      await call(method("setup"), setupOptions);
    });

  for (const [name, action, description] of [
    ["test-speech", "testSpeech", options.descriptions.testSpeech],
    ["test-listen", "testListen", options.descriptions.testListen],
  ] as const) {
    addJoinOptions(command(`${name} <url>`, description))
      .option("--timeout-ms <ms>", "probe timeout in milliseconds")
      .action(async (url: string, joinOptions: JoinOptions) => {
        await call(method(action), joinPayload(url, joinOptions));
      });
  }
}
