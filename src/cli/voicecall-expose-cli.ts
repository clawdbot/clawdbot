import type { Command } from "commander";
import { z } from "zod";

import { loadConfig } from "../config/config.js";
import { callGatewayFromCli } from "./gateway-rpc.js";

function resolveMode(input: string | undefined): "off" | "serve" | "funnel" {
  const raw = (input ?? "").trim().toLowerCase();
  if (raw === "serve" || raw === "off") return raw;
  return "funnel";
}

export function registerVoiceCallExposeCli(program: Command) {
  program
    .command("voicecall:expose")
    .description(
      "Expose the voice-call webhook via Tailscale serve/funnel and print the public URL",
    )
    .option(
      "--mode <mode>",
      "Exposure mode: funnel (public) | serve (tailnet) | off",
      "funnel",
    )
    .option("--url <url>", "Gateway WebSocket URL", "ws://127.0.0.1:18789/ws")
    .option("--token <token>", "Gateway token (if required)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .action(async (opts) => {
      const cfg = loadConfig();
      const voice = cfg.voiceCall;
      if (!voice?.enabled) {
        throw new Error(
          "voiceCall.enabled is false; enable it in config first",
        );
      }

      const schema = z.object({
        path: z.string().min(1),
        port: z.number().int(),
      });
      const serve = schema.pick({ path: true, port: true }).parse({
        path: voice.serve?.path ?? "/voice/webhook",
        port: voice.serve?.port ?? 3334,
      });

      const mode = resolveMode(opts.mode);

      // Ask the gateway to start the voice-call runtime; it will apply tailscale exposure.
      // We temporarily override tailscale.mode via config is not supported yet; so we only
      // print what to set + we can at least confirm runtime is reachable.
      const status = (await callGatewayFromCli("voicecall.status", opts, {
        callId: "__noop__",
      })) as { found?: boolean; error?: string };

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            mode,
            hint: {
              setConfig: {
                "voiceCall.tailscale.mode": mode,
                "voiceCall.tailscale.path": serve.path,
                exposedLocal: `http://127.0.0.1:${serve.port}${serve.path}`,
              },
            },
            gatewayProbe: status,
          },
          null,
          2,
        ),
      );
    });
}
