import type { Command } from "commander";

const GATEWAY_AUTH_MODES = ["none", "token", "password", "trusted-proxy"] as const;
const GATEWAY_TAILSCALE_MODES = ["off", "serve", "funnel"] as const;

function formatModeChoices(modes: readonly string[]): string {
  return modes.map((mode) => `"${mode}"`).join("|");
}

export function addGatewayRunCommand(cmd: Command): Command {
  return cmd
    .option("--port <port>", "Port for the gateway WebSocket")
    .option(
      "--bind <mode>",
      'Bind mode ("loopback"|"lan"|"tailnet"|"auto"|"custom"). Defaults to config gateway.bind (or loopback).',
    )
    .option(
      "--token <token>",
      "Shared token required in connect.params.auth.token (default: OPENCLAW_GATEWAY_TOKEN env if set)",
    )
    .option("--auth <mode>", `Gateway auth mode (${formatModeChoices(GATEWAY_AUTH_MODES)})`)
    .option("--password <password>", "Password for auth mode=password")
    .option("--password-file <path>", "Read gateway password from file")
    .option(
      "--tailscale <mode>",
      `Tailscale exposure mode (${formatModeChoices(GATEWAY_TAILSCALE_MODES)})`,
    )
    .option(
      "--tailscale-reset-on-exit",
      "Reset Tailscale serve/funnel configuration on shutdown",
      false,
    )
    .option(
      "--allow-unconfigured",
      "Allow gateway start without enforcing gateway.mode=local in config (does not repair config)",
      false,
    )
    .option("--dev", "Create a dev config + workspace if missing (no BOOTSTRAP.md)", false)
    .option(
      "--reset",
      "Reset dev config + credentials + sessions + workspace (requires --dev)",
      false,
    )
    .option("--force", "Kill any existing listener on the target port before starting", false)
    .option("--verbose", "Verbose logging to stdout/stderr", false)
    .option(
      "--cli-backend-logs",
      "Only show CLI backend logs in the console (includes stdout/stderr)",
      false,
    )
    .option("--claude-cli-logs", "Deprecated alias for --cli-backend-logs", false)
    .option("--ws-log <style>", 'WebSocket log style ("auto"|"full"|"compact")', "auto")
    .option("--compact", 'Alias for "--ws-log compact"', false)
    .option("--raw-stream", "Log raw model stream events to jsonl", false)
    .option("--raw-stream-path <path>", "Raw stream jsonl path")
    .action(async (opts, command) => {
      const { resolveGatewayRunOptions, runGatewayCommand } = await import("./run.js");
      await runGatewayCommand(resolveGatewayRunOptions(opts, command));
    });
}
