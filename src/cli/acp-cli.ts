// Commander registration for native ACP, the explicit Gateway bridge, and ACP clients.
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { ACP_RUNTIME_INFO } from "../acp/runtime-info.js";
import { normalizeAcpProvenanceMode } from "../acp/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime } from "../runtime.js";
import { inheritOptionFromParent } from "./command-options.js";
import { resolveGatewayAuthOptions } from "./gateway-secret-options.js";

function configureGatewayCommand(command: Command): Command {
  return command
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--token-file <path>", "Read gateway token from file")
    .option("--password <password>", "Gateway password (if required)")
    .option("--password-file <path>", "Read gateway password from file")
    .option("--session <key>", "Default session key (e.g. agent:main:main)")
    .option("--session-label <label>", "Default session label to resolve")
    .option("--require-existing", "Fail if the session key/label does not exist", false)
    .option("--reset-session", "Reset the session key before first use", false)
    .option("--no-prefix-cwd", "Do not prefix prompts with the working directory")
    .option("--provenance <mode>", "ACP provenance mode: off, meta, or meta+receipt")
    .option("-v, --verbose", "Verbose logging to stderr", false)
    .action(async (opts, actionCommand) => {
      try {
        const option = (name: string): unknown =>
          inheritOptionFromParent(actionCommand, name) ?? opts[name];
        const gatewayOptions = {
          token: option("token") as string | undefined,
          tokenFile: option("tokenFile") as string | undefined,
          password: option("password") as string | undefined,
          passwordFile: option("passwordFile") as string | undefined,
        };
        const { gatewayToken, gatewayPassword } = resolveGatewayAuthOptions(gatewayOptions);
        const provenance = option("provenance") as string | undefined;
        const provenanceMode = normalizeAcpProvenanceMode(provenance);
        if (provenance && !provenanceMode) {
          throw new Error('Invalid --provenance. Use "off", "meta", or "meta+receipt".');
        }
        const { serveAcpGateway } = await import("../acp/server.js");
        await serveAcpGateway({
          gatewayUrl: option("url") as string | undefined,
          gatewayToken,
          gatewayPassword,
          defaultSessionKey: option("session") as string | undefined,
          defaultSessionLabel: option("sessionLabel") as string | undefined,
          requireExistingSession: Boolean(option("requireExisting")),
          resetSession: Boolean(option("resetSession")),
          prefixCwd: option("prefixCwd") !== false,
          provenanceMode,
          verbose: Boolean(option("verbose")),
        });
      } catch (err) {
        defaultRuntime.error(`ACP Gateway bridge failed: ${formatErrorMessage(err)}`);
        defaultRuntime.exit(1);
      }
    });
}

function configureNativeCommand(command: Command): Command {
  return command
    .option("--configure-model", "Configure model authentication and exit", false)
    .action(async (opts) => {
      try {
        if (opts.configureModel) {
          const { configureCommandFromSectionsArg } = await import("../commands/configure.js");
          await configureCommandFromSectionsArg(["model"], defaultRuntime);
          return;
        }
        const { serveAcpNative } = await import("../acp/native-server.js");
        await serveAcpNative();
      } catch (err) {
        defaultRuntime.error(`ACP native agent failed: ${formatErrorMessage(err)}`);
        defaultRuntime.exit(1);
      }
    });
}

export function registerAcpCli(program: Command) {
  const acp = configureGatewayCommand(
    program.command("acp").description("Run OpenClaw ACP runtimes and Gateway bridge tools"),
  ).addHelpText(
    "after",
    () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/acp", "docs.openclaw.ai/cli/acp")}\n`,
  );

  configureNativeCommand(
    acp.command("native").description("Run OpenClaw as a self-contained ACP agent"),
  );

  acp
    .command("info")
    .description("Print the ACP runtime compatibility contract")
    .action(() => {
      defaultRuntime.writeJson(ACP_RUNTIME_INFO, 0);
    });

  configureGatewayCommand(
    acp.command("gateway").description("Alias for the existing Gateway-backed ACP bridge"),
  );

  acp
    .command("client")
    .description("Run an interactive ACP client against an ACP agent")
    .option("--cwd <dir>", "Working directory for the ACP session")
    .option("--server <command>", "ACP server command (default: openclaw)")
    .option("--server-args <args...>", "Extra arguments for the ACP server")
    .option("--server-verbose", "Enable verbose logging on the ACP server", false)
    .option("-v, --verbose", "Verbose client logging", false)
    .action(async (opts, command) => {
      const inheritedVerbose = inheritOptionFromParent<boolean>(command, "verbose");
      try {
        const { runAcpClientInteractive } = await import("../acp/client.js");
        await runAcpClientInteractive({
          cwd: opts.cwd as string | undefined,
          serverCommand: opts.server as string | undefined,
          serverArgs: opts.serverArgs as string[] | undefined,
          serverVerbose: Boolean(opts.serverVerbose),
          verbose: Boolean(opts.verbose || inheritedVerbose),
        });
      } catch (err) {
        defaultRuntime.error(formatErrorMessage(err));
        defaultRuntime.exit(1);
      }
    });
}
