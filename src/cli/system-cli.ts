import type { Command } from "commander";

import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import type { GatewayRpcOpts } from "./gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";

type SystemEventOpts = GatewayRpcOpts & { text?: string; mode?: string; json?: boolean };

const normalizeWakeMode = (raw: unknown) => {
  const mode = typeof raw === "string" ? raw.trim() : "";
  if (!mode) return "next-heartbeat" as const;
  if (mode === "now" || mode === "next-heartbeat") return mode;
  throw new Error("--mode must be now or next-heartbeat");
};

export function registerSystemCli(program: Command) {
  const system = program
    .command("system")
    .description("System tools (events, heartbeat, presence)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/system", "docs.molt.bot/cli/system")}\n`,
    );

  addGatewayClientOptions(
    system
      .command("event")
      .description("Enqueue a system event and optionally trigger a heartbeat")
      .requiredOption("--text <text>", "System event text")
      .option("--mode <mode>", "Wake mode (now|next-heartbeat)", "next-heartbeat")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SystemEventOpts) => {
    try {
      const text = typeof opts.text === "string" ? opts.text.trim() : "";
      if (!text) throw new Error("--text is required");
      const mode = normalizeWakeMode(opts.mode);
      const result = await callGatewayFromCli("wake", opts, { mode, text }, { expectFinal: false });
      if (opts.json) defaultRuntime.log(JSON.stringify(result, null, 2));
      else defaultRuntime.log("ok");
    } catch (err) {
      defaultRuntime.error(danger(String(err)));
      defaultRuntime.exit(1);
    }
  });

  const heartbeat = system.command("heartbeat").description("Heartbeat controls");

  addGatewayClientOptions(
    heartbeat
      .command("last")
      .description("Show the last heartbeat event")
      .option("--json", "Output JSON", false),
  ).action(async (opts: GatewayRpcOpts & { json?: boolean }) => {
    try {
      const result = await callGatewayFromCli("last-heartbeat", opts, undefined, {
        expectFinal: false,
      });
      defaultRuntime.log(JSON.stringify(result, null, 2));
    } catch (err) {
      defaultRuntime.error(danger(String(err)));
      defaultRuntime.exit(1);
    }
  });

  addGatewayClientOptions(
    heartbeat
      .command("enable")
      .description("Enable heartbeats")
      .option("--json", "Output JSON", false),
  ).action(async (opts: GatewayRpcOpts & { json?: boolean }) => {
    try {
      const result = await callGatewayFromCli(
        "set-heartbeats",
        opts,
        { enabled: true },
        { expectFinal: false },
      );
      defaultRuntime.log(JSON.stringify(result, null, 2));
    } catch (err) {
      defaultRuntime.error(danger(String(err)));
      defaultRuntime.exit(1);
    }
  });

  addGatewayClientOptions(
    heartbeat
      .command("disable")
      .description("Disable heartbeats")
      .option("--json", "Output JSON", false),
  ).action(async (opts: GatewayRpcOpts & { json?: boolean }) => {
    try {
      const result = await callGatewayFromCli(
        "set-heartbeats",
        opts,
        { enabled: false },
        { expectFinal: false },
      );
      defaultRuntime.log(JSON.stringify(result, null, 2));
    } catch (err) {
      defaultRuntime.error(danger(String(err)));
      defaultRuntime.exit(1);
    }
  });

  addGatewayClientOptions(
    system
      .command("presence")
      .description("List system presence entries")
      .option("--json", "Output JSON", false),
  ).action(async (opts: GatewayRpcOpts & { json?: boolean }) => {
    try {
      const result = await callGatewayFromCli("system-presence", opts, undefined, {
        expectFinal: false,
      });
      defaultRuntime.log(JSON.stringify(result, null, 2));
    } catch (err) {
      defaultRuntime.error(danger(String(err)));
      defaultRuntime.exit(1);
    }
  });
}
