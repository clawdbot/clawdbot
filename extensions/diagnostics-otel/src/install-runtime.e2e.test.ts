import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { readPluginInstallRecords } from "../../../scripts/e2e/lib/plugins/plugin-index-sqlite.mjs";
import { startQaGatewayChild } from "../../qa-lab/api.js";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "@openclaw/diagnostics-otel";
const PACKAGE_VERSION = "2026.7.2";

type MutableConfig = {
  diagnostics?: unknown;
  plugins?: {
    entries?: Record<string, { enabled?: boolean }>;
  };
  [key: string]: unknown;
};

type TraceRequest = {
  at: number;
  path: string;
  spanEndTimesMs: number[];
};

class ProtoReader {
  private offset = 0;

  constructor(private readonly buffer: Uint8Array) {}

  done() {
    return this.offset >= this.buffer.length;
  }

  tag() {
    const raw = this.varint();
    return { field: raw >>> 3, wire: raw & 7 };
  }

  varint() {
    let result = 0;
    let shift = 0;
    while (this.offset < this.buffer.length) {
      const byte = this.buffer[this.offset++];
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        return result;
      }
      shift += 7;
    }
    throw new Error("truncated protobuf varint");
  }

  bytes() {
    const length = this.varint();
    const end = this.offset + length;
    if (end > this.buffer.length) {
      throw new Error("truncated protobuf bytes");
    }
    const value = this.buffer.subarray(this.offset, end);
    this.offset = end;
    return value;
  }

  fixed64() {
    const end = this.offset + 8;
    if (end > this.buffer.length) {
      throw new Error("truncated protobuf fixed64");
    }
    const value = Buffer.from(this.buffer.subarray(this.offset, end)).readBigUInt64LE();
    this.offset = end;
    return value;
  }

  skip(wire: number) {
    if (wire === 0) {
      this.varint();
      return;
    }
    if (wire === 1) {
      this.fixed64();
      return;
    }
    if (wire === 2) {
      this.bytes();
      return;
    }
    if (wire === 5) {
      this.offset += 4;
      return;
    }
    throw new Error(`unsupported protobuf wire type ${wire}`);
  }
}

function decodeSpanEndTime(message: Uint8Array) {
  const reader = new ProtoReader(message);
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 8 && wire === 1) {
      return Number(reader.fixed64() / 1_000_000n);
    }
    reader.skip(wire);
  }
  return undefined;
}

function decodeScopeSpanEndTimes(message: Uint8Array) {
  const reader = new ProtoReader(message);
  const times: number[] = [];
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 2 && wire === 2) {
      const endTime = decodeSpanEndTime(reader.bytes());
      if (endTime !== undefined) {
        times.push(endTime);
      }
    } else {
      reader.skip(wire);
    }
  }
  return times;
}

function decodeResourceSpanEndTimes(message: Uint8Array) {
  const reader = new ProtoReader(message);
  const times: number[] = [];
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 2 && wire === 2) {
      times.push(...decodeScopeSpanEndTimes(reader.bytes()));
    } else {
      reader.skip(wire);
    }
  }
  return times;
}

function decodeTraceRequestEndTimes(message: Uint8Array) {
  const reader = new ProtoReader(message);
  const times: number[] = [];
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      times.push(...decodeResourceSpanEndTimes(reader.bytes()));
    } else {
      reader.skip(wire);
    }
  }
  return times;
}

async function stopServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function startReceiver() {
  const requests: TraceRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const requestPath = request.url ?? "";
    requests.push({
      at: Date.now(),
      path: requestPath,
      spanEndTimesMs:
        requestPath === "/v1/traces" ? decodeTraceRequestEndTimes(Buffer.concat(chunks)) : [],
    });
    response.writeHead(200, { "content-type": "application/x-protobuf" });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("OTLP receiver did not bind");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests, server };
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), sleep(5_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await sleep(100);
  }
  throw new Error("timed out waiting for managed diagnostics-otel evidence");
}

async function startMockProvider(repoRoot: string) {
  const apiUrl = pathToFileURL(path.join(repoRoot, "extensions/qa-lab/api.ts")).href;
  const source = [
    'import { Command } from "commander";',
    `import { registerQaLabCli } from ${JSON.stringify(apiUrl)};`,
    "const program = new Command();",
    "registerQaLabCli(program);",
    'await program.parseAsync(["node", "qa-provider", "qa", "mock-openai", "--host", "127.0.0.1", "--port", "0"]);',
  ].join("\n");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const baseUrl = await waitFor(() => {
    const match = output.match(/QA mock OpenAI: (http:\/\/127\.0\.0\.1:\d+)/u);
    if (match?.[1]) {
      return match[1];
    }
    if (child.exitCode !== null) {
      throw new Error(`QA mock provider exited early (${child.exitCode}): ${output}`);
    }
    return undefined;
  });
  return { baseUrl, child };
}

async function packPlugin(repoRoot: string, scratch: string) {
  const outputDir = path.join(scratch, "pack");
  await execFileAsync(
    "bash",
    ["scripts/plugin-npm-publish.sh", "--pack", "extensions/diagnostics-otel"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR: outputDir,
      },
      timeout: 120_000,
    },
  );
  const tarballName = (await readdir(outputDir)).find((name) => name.endsWith(".tgz"));
  if (!tarballName) {
    throw new Error("diagnostics-otel pack did not produce a tarball");
  }
  return path.join(outputDir, tarballName);
}

async function startRegistry(repoRoot: string, scratch: string, tarball: string) {
  const portFile = path.join(scratch, "registry-port");
  const child = spawn(
    process.execPath,
    [
      "scripts/e2e/lib/plugins/npm-registry-server.mjs",
      portFile,
      PACKAGE_NAME,
      PACKAGE_VERSION,
      tarball,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        OPENCLAW_NPM_REGISTRY_UPSTREAM: "https://registry.npmjs.org",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const port = await waitFor(async () => {
    try {
      return (await readFile(portFile, "utf8")).trim() || undefined;
    } catch {
      if (child.exitCode !== null) {
        throw new Error(`fixture npm registry exited early (${child.exitCode})`);
      }
      return undefined;
    }
  });
  return { baseUrl: `http://127.0.0.1:${port}`, child };
}

async function runTurn(gateway: Awaited<ReturnType<typeof startQaGatewayChild>>, marker: string) {
  const started = (await gateway.call("chat.send", {
    sessionKey: `agent:main:${marker.toLowerCase()}`,
    message: `Reply exactly: ${marker}`,
    idempotencyKey: randomUUID(),
  })) as { runId?: string; status?: string };
  expect(started.status).toBe("started");
  expect(started.runId).toBeTruthy();
  const completed = (await gateway.call(
    "agent.wait",
    { runId: started.runId, timeoutMs: 60_000 },
    { timeoutMs: 65_000 },
  )) as { status?: string };
  expect(completed.status).toBe("ok");
}

async function installAndConfigure(params: {
  configTraceEndpoint: string;
  envTraceEndpoint: string;
  mockBaseUrl: string;
  nodeOptions?: string;
  registryBaseUrl: string;
  repoRoot: string;
}) {
  const gateway = await startQaGatewayChild({
    repoRoot: params.repoRoot,
    useRepoCli: true,
    providerBaseUrl: `${params.mockBaseUrl}/v1`,
    providerMode: "mock-openai",
    transportBaseUrl: "http://127.0.0.1:9",
    controlUiEnabled: false,
    runtimeEnvPatch: {
      NPM_CONFIG_REGISTRY: params.registryBaseUrl,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${params.envTraceEndpoint}/v1/traces`,
      ...(params.nodeOptions ? { NODE_OPTIONS: params.nodeOptions } : {}),
      ...(params.nodeOptions ? { OPENCLAW_OTEL_PRELOADED: "1" } : {}),
    },
  });
  const spec = `npm:${PACKAGE_NAME}@${PACKAGE_VERSION}`;
  await gateway.runCli(["plugins", "install", spec, "--force"]);
  const records = readPluginInstallRecords({
    stateDir: gateway.tempRoot,
    configPath: gateway.configPath,
  });
  expect(records["diagnostics-otel"]).toMatchObject({
    source: "npm",
    spec: `${PACKAGE_NAME}@${PACKAGE_VERSION}`,
    version: PACKAGE_VERSION,
    resolvedName: PACKAGE_NAME,
    resolvedVersion: PACKAGE_VERSION,
  });
  expect(records["diagnostics-otel"]?.installPath).toContain("diagnostics-otel");
  expect(records["diagnostics-otel"]?.integrity).toMatch(/^sha512-/u);

  await gateway.runCli(["plugins", "disable", "diagnostics-otel"]);
  let config = JSON.parse(await readFile(gateway.configPath, "utf8")) as MutableConfig;
  expect(config.plugins?.entries?.["diagnostics-otel"]?.enabled).toBe(false);
  await gateway.runCli(["plugins", "enable", "diagnostics-otel"]);
  config = JSON.parse(await readFile(gateway.configPath, "utf8")) as MutableConfig;
  expect(config.plugins?.entries?.["diagnostics-otel"]?.enabled).toBe(true);

  await gateway.restartAfterStateMutation(async ({ configPath }) => {
    const current = JSON.parse(await readFile(configPath, "utf8")) as MutableConfig;
    current.diagnostics = {
      enabled: true,
      otel: {
        enabled: true,
        protocol: "http/protobuf",
        traces: true,
        metrics: false,
        logs: false,
        tracesEndpoint: `${params.configTraceEndpoint}/v1/traces`,
        sampleRate: 1,
        flushIntervalMs: 250,
        captureContent: false,
      },
    };
    await writeFile(configPath, `${JSON.stringify(current, null, 2)}\n`);
  });
  const inspect = JSON.parse(
    await gateway.runCli(["plugins", "inspect", "diagnostics-otel", "--runtime", "--json"]),
  ) as { plugin?: { enabled?: boolean; id?: string; status?: string } };
  expect(inspect.plugin).toMatchObject({
    enabled: true,
    id: "diagnostics-otel",
    status: "loaded",
  });
  return gateway;
}

describe("managed diagnostics-otel install runtime", () => {
  test("installs the exact package and exports with config precedence, sampling, and flush", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const scratch = await mkdtemp(path.join(tmpdir(), "openclaw-otel-install-"));
    const configured = await startReceiver();
    const envOnly = await startReceiver();
    let registry: Awaited<ReturnType<typeof startRegistry>> | undefined;
    let mock: Awaited<ReturnType<typeof startMockProvider>> | undefined;
    let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
    try {
      const tarball = await packPlugin(repoRoot, scratch);
      registry = await startRegistry(repoRoot, scratch, tarball);
      mock = await startMockProvider(repoRoot);
      gateway = await installAndConfigure({
        configTraceEndpoint: configured.baseUrl,
        envTraceEndpoint: envOnly.baseUrl,
        mockBaseUrl: mock.baseUrl,
        registryBaseUrl: registry.baseUrl,
        repoRoot,
      });
      await runTurn(gateway, "OTEL-MANAGED-INSTALL-OK");
      const traceRequest = await waitFor(
        () =>
          configured.requests.find(
            (request) => request.path === "/v1/traces" && request.spanEndTimesMs.length > 0,
          ),
        15_000,
      );
      // BatchSpanProcessor starts its timer on the first ended span. The first
      // export's earliest end timestamp is the boundary that must observe the clamp.
      const firstSpanEndAt = Math.min(...traceRequest.spanEndTimesMs);
      const exportDelayMs = traceRequest.at - firstSpanEndAt;
      expect(exportDelayMs).toBeGreaterThanOrEqual(1_000);
      expect(exportDelayMs).toBeLessThan(4_500);
      expect(envOnly.requests).toHaveLength(0);
    } finally {
      await gateway?.stop();
      await stopChild(mock?.child);
      await stopChild(registry?.child);
      await stopServer(configured.server);
      await stopServer(envOnly.server);
      await rm(scratch, { recursive: true, force: true });
    }
  }, 180_000);

  test("keeps installed diagnostic listeners active with a preloaded SDK", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const scratch = await mkdtemp(path.join(tmpdir(), "openclaw-otel-preloaded-"));
    const receiver = await startReceiver();
    const ignoredConfig = await startReceiver();
    let registry: Awaited<ReturnType<typeof startRegistry>> | undefined;
    let mock: Awaited<ReturnType<typeof startMockProvider>> | undefined;
    let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
    try {
      const tarball = await packPlugin(repoRoot, scratch);
      registry = await startRegistry(repoRoot, scratch, tarball);
      mock = await startMockProvider(repoRoot);
      const preloadPath = path.join(repoRoot, ".artifacts", `otel-preload-${randomUUID()}.mjs`);
      await mkdir(path.dirname(preloadPath), { recursive: true });
      await writeFile(
        preloadPath,
        [
          'import { NodeSDK } from "@opentelemetry/sdk-node";',
          'import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";',
          `const sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter({ url: ${JSON.stringify(`${receiver.baseUrl}/v1/traces`)} }) });`,
          "sdk.start();",
          "globalThis.__openclawQaPreloadedOtelSdk = sdk;",
        ].join("\n"),
      );
      try {
        gateway = await installAndConfigure({
          configTraceEndpoint: ignoredConfig.baseUrl,
          envTraceEndpoint: receiver.baseUrl,
          mockBaseUrl: mock.baseUrl,
          nodeOptions: `--import=${pathToFileURL(preloadPath).href}`,
          registryBaseUrl: registry.baseUrl,
          repoRoot,
        });
        expect(gateway.logs()).toContain("diagnostics-otel: using preloaded OpenTelemetry SDK");
        await runTurn(gateway, "OTEL-PRELOADED-INSTALL-OK");
        await waitFor(
          () => receiver.requests.find((request) => request.path === "/v1/traces"),
          20_000,
        );
        expect(ignoredConfig.requests).toHaveLength(0);
      } finally {
        await rm(preloadPath, { force: true });
      }
    } finally {
      await gateway?.stop();
      await stopChild(mock?.child);
      await stopChild(registry?.child);
      await stopServer(receiver.server);
      await stopServer(ignoredConfig.server);
      await rm(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});
