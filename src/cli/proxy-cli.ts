import { parseStrictInteger } from "@openclaw/normalization-core/number-coercion";
// Commander registration for debug proxy capture, validation, query, and blob commands.
import { InvalidArgumentError, Option, type Command } from "commander";
import { CAPTURE_QUERY_PRESETS, type CaptureQueryPreset } from "../proxy-capture/types.js";
import { createLazyPromise } from "../shared/lazy-promise.js";
import { collectOption, parseStrictPositiveIntOption } from "./program/helpers.js";
import { setCommandJsonMode } from "./program/json-mode.js";
import { isProxyMachineOutput } from "./proxy-output-mode.js";

// Keep proxy CA/server/sqlite dependencies out of normal CLI startup.
const loadProxyCliRuntime = createLazyPromise(() => import("./proxy-cli.runtime.js"));

function parsePortOption(value: string | undefined): number {
  const parsed = parseStrictInteger(value);
  if (parsed === undefined) {
    throw new InvalidArgumentError("--port must be an integer.");
  }
  if (parsed < 0 || parsed > 65_535) {
    throw new InvalidArgumentError("--port must be between 0 and 65535.");
  }
  return parsed;
}

export function registerProxyCli(program: Command) {
  const proxy = program
    .command("proxy")
    .description("Run the OpenClaw debug proxy and inspect captured traffic");
  setCommandJsonMode(proxy, "output", ({ argv }) => isProxyMachineOutput(argv));

  proxy
    .command("start")
    .description("Start the local explicit debug proxy")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", parsePortOption)
    .action(async (opts: { host?: string; port?: number }) => {
      const runtime = await loadProxyCliRuntime();
      await runtime.runDebugProxyStartCommand(opts);
    });

  proxy
    .command("run")
    .description("Run a child command with OpenClaw debug proxy capture enabled")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", parsePortOption)
    .argument("[cmd...]", "Command to run after --")
    .action(async (cmd: string[], opts: { host?: string; port?: number }) => {
      const runtime = await loadProxyCliRuntime();
      await runtime.runDebugProxyRunCommand({
        host: opts.host,
        port: opts.port,
        commandArgs: cmd,
      });
    });

  proxy
    .command("validate")
    .description("Validate the operator-managed network proxy")
    .option("--json", "Print machine-readable JSON")
    .option("--proxy-url <url>", "Proxy URL to validate instead of config/env")
    .option("--proxy-ca-file <path>", "CA bundle file for verifying an HTTPS proxy endpoint")
    .option(
      "--allowed-url <url>",
      "Destination expected to succeed through the proxy",
      collectOption,
    )
    .option("--denied-url <url>", "Destination expected to be blocked by the proxy", collectOption)
    .option("--apns-reachable", "Also verify sandbox APNs HTTP/2 is reachable through the proxy")
    .option("--apns-authority <url>", "APNs authority to probe with --apns-reachable")
    .option("--timeout-ms <ms>", "Per-request timeout in milliseconds", (value) =>
      parseStrictPositiveIntOption(value, "--timeout-ms"),
    )
    .action(
      async (opts: {
        json?: boolean;
        proxyUrl?: string;
        proxyCaFile?: string;
        allowedUrl?: string[];
        deniedUrl?: string[];
        apnsReachable?: boolean;
        apnsAuthority?: string;
        timeoutMs?: number;
      }) => {
        const runtime = await loadProxyCliRuntime();
        await runtime.runProxyValidateCommand({
          json: opts.json,
          proxyUrl: opts.proxyUrl,
          proxyCaFile: opts.proxyCaFile,
          allowedUrls: opts.allowedUrl,
          deniedUrls: opts.deniedUrl,
          apnsReachability: opts.apnsReachable,
          apnsAuthority: opts.apnsAuthority,
          timeoutMs: opts.timeoutMs,
        });
      },
    );

  proxy
    .command("coverage")
    .description("Report current debug proxy transport coverage and remaining gaps")
    .option("--json", "Print machine-readable JSON")
    .action(async () => {
      const runtime = await loadProxyCliRuntime();
      await runtime.runDebugProxyCoverageCommand();
    });

  proxy
    .command("sessions")
    .description("List recent capture sessions")
    .option("--json", "Print machine-readable JSON")
    .option("--limit <count>", "Maximum sessions to show", (value) =>
      parseStrictPositiveIntOption(value, "--limit"),
    )
    .action(async (opts: { json?: boolean; limit?: number }) => {
      const runtime = await loadProxyCliRuntime();
      await runtime.runDebugProxySessionsCommand(opts);
    });

  proxy
    .command("query")
    .description("Run a built-in query preset against captured traffic")
    .addOption(
      new Option("--preset <name>", "Query preset")
        .choices(CAPTURE_QUERY_PRESETS)
        .makeOptionMandatory(),
    )
    .option("--json", "Print machine-readable JSON")
    .option("--session <id>", "Restrict to a capture session id")
    .action(async (opts: { json?: boolean; preset: CaptureQueryPreset; session?: string }) => {
      const runtime = await loadProxyCliRuntime();
      await runtime.runDebugProxyQueryCommand({
        json: opts.json,
        preset: opts.preset,
        sessionId: opts.session,
      });
    });

  proxy
    .command("blob")
    .description("Read a captured payload blob by id")
    .requiredOption("--id <blobId>", "Blob id")
    .action(async (opts: { id: string }) => {
      const runtime = await loadProxyCliRuntime();
      await runtime.readDebugProxyBlobCommand({ blobId: opts.id });
    });

  proxy
    .command("purge")
    .description("Delete all captured traffic metadata and blobs")
    .action(async () => {
      const runtime = await loadProxyCliRuntime();
      await runtime.runDebugProxyPurgeCommand();
    });
}
