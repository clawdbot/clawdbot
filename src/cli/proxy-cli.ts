import type { Command } from "commander";
import type { CaptureQueryPreset } from "../proxy-capture/types.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";

type ProxyCliRuntime = typeof import("./proxy-cli.runtime.js");

const proxyCliRuntimeLoader = createLazyImportLoader<ProxyCliRuntime>(
  () => import("./proxy-cli.runtime.js"),
);

async function loadProxyCliRuntime(): Promise<ProxyCliRuntime> {
  return await proxyCliRuntimeLoader.load();
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function collectOption(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

export function registerProxyCli(program: Command) {
  const proxy = program
    .command("proxy")
    .description("Run the OpenClaw debug proxy and inspect captured traffic");

  proxy
    .command("start")
    .description("Start the local explicit debug proxy")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", parseOptionalNumber)
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
    .option("--port <port>", "Bind port", parseOptionalNumber)
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
    .option(
      "--allowed-url <url>",
      "Destination expected to succeed through the proxy",
      collectOption,
    )
    .option("--denied-url <url>", "Destination expected to be blocked by the proxy", collectOption)
    .option("--timeout-ms <ms>", "Per-request timeout in milliseconds", parseOptionalNumber)
    .action(
      async (opts: {
        json?: boolean;
        proxyUrl?: string;
        allowedUrl?: string[];
        deniedUrl?: string[];
        timeoutMs?: number;
      }) => {
        const runtime = await loadProxyCliRuntime();
        await runtime.runProxyValidateCommand({
          json: opts.json,
          proxyUrl: opts.proxyUrl,
          allowedUrls: opts.allowedUrl,
          deniedUrls: opts.deniedUrl,
          timeoutMs: opts.timeoutMs,
        });
      },
    );

  proxy
    .command("coverage")
    .description("Report current debug proxy transport coverage and remaining gaps")
    .action(async () => {
      const runtime = await loadProxyCliRuntime();
      await runtime.runDebugProxyCoverageCommand();
    });

  proxy
    .command("sessions")
    .description("List recent capture sessions")
    .option("--limit <count>", "Maximum sessions to show", parseOptionalNumber)
    .action(async (opts: { limit?: number }) => {
      const runtime = await loadProxyCliRuntime();
      await runtime.runDebugProxySessionsCommand(opts);
    });

  proxy
    .command("query")
    .description("Run a built-in query preset against captured traffic")
    .requiredOption(
      "--preset <name>",
      "Query preset: double-sends, retry-storms, cache-busting, ws-duplicate-frames, missing-ack, error-bursts",
    )
    .option("--session <id>", "Restrict to a capture session id")
    .action(async (opts: { preset: CaptureQueryPreset; session?: string }) => {
      const runtime = await loadProxyCliRuntime();
      await runtime.runDebugProxyQueryCommand({
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
