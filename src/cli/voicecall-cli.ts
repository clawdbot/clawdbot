import fs from "node:fs";

import type { Command } from "commander";

function resolveDefaultStorePath(): string {
  const home = process.env.HOME || "/tmp";
  return `${home}/clawd/voice-calls/calls.jsonl`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveMode(input: string): "off" | "serve" | "funnel" {
  const raw = input.trim().toLowerCase();
  if (raw === "serve" || raw === "off") return raw;
  return "funnel";
}

export function registerVoiceCallCli(program: Command) {
  const root = program.command("voicecall").description("Voice call utilities");

  root
    .command("tail")
    .description(
      "Tail voice-call JSONL logs (prints new lines; useful during provider tests)",
    )
    .option("--file <path>", "Path to calls.jsonl", resolveDefaultStorePath())
    .option("--since <n>", "Print last N lines first", "25")
    .option("--poll <ms>", "Poll interval in ms", "250")
    .action(
      async (options: { file: string; since?: string; poll?: string }) => {
        const file = options.file;
        const since = Math.max(0, Number(options.since ?? 0));
        const pollMs = Math.max(50, Number(options.poll ?? 250));

        if (!fs.existsSync(file)) {
          // eslint-disable-next-line no-console
          console.error(`No log file at ${file}`);
          process.exit(1);
        }

        // Print last N lines.
        const initial = fs.readFileSync(file, "utf8");
        const lines = initial.split("\n").filter(Boolean);
        for (const line of lines.slice(Math.max(0, lines.length - since))) {
          // eslint-disable-next-line no-console
          console.log(line);
        }

        let offset = Buffer.byteLength(initial, "utf8");

        for (;;) {
          try {
            const stat = fs.statSync(file);
            if (stat.size < offset) {
              offset = 0;
            }
            if (stat.size > offset) {
              const fd = fs.openSync(file, "r");
              try {
                const buf = Buffer.alloc(stat.size - offset);
                fs.readSync(fd, buf, 0, buf.length, offset);
                offset = stat.size;
                const text = buf.toString("utf8");
                for (const line of text.split("\n").filter(Boolean)) {
                  // eslint-disable-next-line no-console
                  console.log(line);
                }
              } finally {
                fs.closeSync(fd);
              }
            }
          } catch {
            // ignore and retry
          }
          await sleep(pollMs);
        }
      },
    );

  root
    .command("expose")
    .description("Enable/disable Tailscale serve/funnel for the webhook")
    .option(
      "--mode <mode>",
      "off | serve (tailnet) | funnel (public)",
      "funnel",
    )
    .option(
      "--path <path>",
      "Tailscale path to expose (recommend matching voiceCall.serve.path)",
    )
    .option("--port <port>", "Local webhook port")
    .option("--serve-path <path>", "Local webhook path")
    .action(
      async (options: {
        mode?: string;
        port?: string;
        path?: string;
        servePath?: string;
      }) => {
        const mode = resolveMode(options.mode ?? "funnel");

        const home = process.env.HOME || "/tmp";
        const configPath = `${home}/.clawdbot/clawdbot.json`;
        let cfg: Record<string, unknown> = {};
        try {
          cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
        } catch {
          // ignore
        }

        const vc = (cfg.voiceCall ?? {}) as {
          serve?: { port?: number; path?: string };
          tailscale?: { path?: string };
        };
        const servePort = Number(options.port ?? vc.serve?.port ?? 3334);
        const servePath = String(
          options.servePath ?? vc.serve?.path ?? "/voice/webhook",
        );
        const tsPath = String(options.path ?? vc.tailscale?.path ?? servePath);

        const localUrl = `http://127.0.0.1:${servePort}`;

        const { setupTailscaleExposureRoute, cleanupTailscaleExposureRoute } =
          await import("../voice-call/webhook.js");

        if (mode === "off") {
          // Try disabling both (harmless if not active).
          await cleanupTailscaleExposureRoute({ mode: "serve", path: tsPath });
          await cleanupTailscaleExposureRoute({ mode: "funnel", path: tsPath });
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify({ ok: true, mode: "off", path: tsPath }, null, 2),
          );
          return;
        }

        const { getTailscaleSelfInfo } = await import(
          "../voice-call/webhook.js"
        );

        const publicUrl = await setupTailscaleExposureRoute({
          mode,
          path: tsPath,
          localUrl,
        });

        const tsInfo = publicUrl ? null : await getTailscaleSelfInfo();
        const enableUrl = tsInfo?.nodeId
          ? `https://login.tailscale.com/f/${mode}?node=${tsInfo.nodeId}`
          : null;

        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              ok: Boolean(publicUrl),
              mode,
              path: tsPath,
              localUrl,
              publicUrl,
              hint: publicUrl
                ? undefined
                : {
                    note: "Tailscale serve/funnel may be disabled on this tailnet (or require admin enable).",
                    enableUrl,
                  },
            },
            null,
            2,
          ),
        );
      },
    );
}
