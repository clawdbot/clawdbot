import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import type { startQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { NodePluginToolDescriptor } from "../../../../packages/gateway-protocol/src/schema/nodes.js";
import type { McpServerConfig } from "../../../../src/config/types.mcp.js";

export const TEST_TIMEOUT_MS = 180_000;
const WAIT_TIMEOUT_MS = 30_000;
const FIXTURE_READY_TYPE = "openclaw-mcp-parity-ready";
const NODE_DISPLAY_NAME = "QA MCP parity node";
export const NODE_MCP_COMMAND = "mcp.tools.call.v1";
export const WAIT_OPTIONS = { timeout: WAIT_TIMEOUT_MS, interval: 100 };
export const MCP_SERVERS = ["sse", "stdio", "streamableHttp"] as const;
const MCP_LABELS = { sse: "sse", stdio: "stdio", streamableHttp: "streamable-http" } as const;
type McpServerName = keyof typeof MCP_LABELS;

export type GatewayHandle = Awaited<ReturnType<typeof startQaGatewayChild>>;
export type CapturedChild = {
  child: ChildProcess;
  exited: Promise<void>;
  logs: () => string;
};
export type HttpFixture = CapturedChild & {
  pid: number;
  urls: {
    streamableHttp: string;
    sse: string;
  };
};
type NodeRead = {
  nodeId: string;
  displayName?: string;
  approvalState?: string;
  paired?: boolean;
  connected?: boolean;
  nodePluginTools?: NodePluginToolDescriptor[];
};
export type ProbeResult = {
  label: string;
  marker: string;
  pid: number;
};
type EffectiveTool = {
  id?: string;
  source?: string;
  pluginId?: string;
};
export type ToolsEffectiveResult = {
  groups?: Array<{ tools?: EffectiveTool[] }>;
};

const CHILD_ENV_KEYS = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec"] as const;

function captureChild(child: ChildProcess): CapturedChild {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = (stdout + chunk.toString()).slice(-200_000);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-200_000);
  });
  return {
    child,
    exited: once(child, "exit").then(() => {}),
    logs: () => `stdout:\n${stdout}\nstderr:\n${stderr}`,
  };
}

export function createChildEnv(params: {
  home: string;
  tempDir: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return {
    ...env,
    HOME: params.home,
    USERPROFILE: params.home,
    XDG_CACHE_HOME: path.join(params.home, ".cache"),
    XDG_CONFIG_HOME: path.join(params.home, ".config"),
    XDG_DATA_HOME: path.join(params.home, ".local", "share"),
    TMPDIR: params.tempDir,
    TMP: params.tempDir,
    TEMP: params.tempDir,
    ...params.extra,
  };
}

export async function startHttpFixture(params: {
  fixturePath: string;
  labelPrefix: "session" | "node";
  env: NodeJS.ProcessEnv;
}): Promise<HttpFixture> {
  const captured = captureChild(
    spawn(process.execPath, [params.fixturePath, "http", "--label-prefix", params.labelPrefix], {
      cwd: process.cwd(),
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const pid = captured.child.pid;
  if (pid === undefined) {
    throw new Error("HTTP MCP fixture did not start");
  }
  if (!captured.child.stdout) {
    throw new Error("HTTP MCP fixture stdout was not piped");
  }
  const lines = createInterface({ input: captured.child.stdout });
  const line = await Promise.race([
    new Promise<string>((resolve) => {
      lines.once("line", resolve);
    }),
    captured.exited.then(() => {
      throw new Error(`HTTP MCP fixture exited before readiness:\n${captured.logs()}`);
    }),
    delay(WAIT_TIMEOUT_MS, undefined, { ref: false }).then(() => {
      throw new Error(`HTTP MCP fixture readiness timed out:\n${captured.logs()}`);
    }),
  ]);
  lines.close();
  const value: unknown = JSON.parse(line);
  if (
    !isRecord(value) ||
    value.type !== FIXTURE_READY_TYPE ||
    !isRecord(value.urls) ||
    typeof value.urls.streamableHttp !== "string" ||
    typeof value.urls.sse !== "string"
  ) {
    throw new Error(`HTTP MCP fixture returned invalid readiness: ${line}`);
  }
  return {
    ...captured,
    pid,
    urls: { streamableHttp: value.urls.streamableHttp, sse: value.urls.sse },
  };
}

export function startNodeProcess(gatewayPort: number, nodeEnv: NodeJS.ProcessEnv): CapturedChild {
  return captureChild(
    spawn(
      process.execPath,
      [
        "dist/index.js",
        "node",
        "run",
        "--host",
        "127.0.0.1",
        "--port",
        String(gatewayPort),
        "--display-name",
        NODE_DISPLAY_NAME,
      ],
      {
        cwd: process.cwd(),
        env: nodeEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
}

export async function stopChild(captured: CapturedChild | undefined): Promise<void> {
  if (!captured || captured.child.exitCode !== null || captured.child.signalCode !== null) {
    await captured?.exited.catch(() => {});
    return;
  }
  captured.child.kill("SIGTERM");
  const graceful = await Promise.race([
    captured.exited.then(() => true),
    delay(10_000, false, { ref: false }),
  ]);
  if (!graceful) {
    captured.child.kill("SIGKILL");
    await captured.exited;
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function waitForProcessExit(pid: number): Promise<void> {
  await vi.waitFor(() => expect(processIsAlive(pid)).toBe(false), WAIT_OPTIONS);
}

export async function approvePairing(
  gateway: GatewayHandle,
  kind: "device" | "node",
  nodeId?: string,
): Promise<string> {
  let requestId = "";
  let approvedId = "";
  await vi.waitFor(async () => {
    const result = (await gateway.call(`${kind}.pair.list`, {})) as {
      pending?: Array<{
        requestId?: string;
        deviceId?: string;
        nodeId?: string;
        role?: string;
      }>;
    };
    const pending = result.pending?.find((entry) =>
      kind === "device" ? entry.role === "node" : entry.nodeId === nodeId,
    );
    expect(pending?.requestId, gateway.logs()).toBeTruthy();
    requestId = pending?.requestId ?? "";
    approvedId = kind === "device" ? (pending?.deviceId ?? "") : (pending?.nodeId ?? "");
    expect(approvedId, gateway.logs()).toBeTruthy();
  }, WAIT_OPTIONS);
  await gateway.call(`${kind}.pair.approve`, { requestId });
  return approvedId;
}

export async function readNode(
  gateway: GatewayHandle,
  nodeId: string,
): Promise<NodeRead | undefined> {
  const result = (await gateway.call("node.list", {})) as { nodes?: NodeRead[] };
  return result.nodes?.find((entry) => entry.nodeId === nodeId);
}

export async function waitForNode(
  gateway: GatewayHandle,
  nodeId: string,
  toolCount?: number,
): Promise<NodeRead> {
  let node: NodeRead | undefined;
  await vi.waitFor(async () => {
    node = await readNode(gateway, nodeId);
    expect(node, gateway.logs()).toMatchObject({
      nodeId,
      displayName: NODE_DISPLAY_NAME,
      approvalState: "approved",
      paired: true,
      connected: true,
    });
    if (toolCount !== undefined) {
      expect(node?.nodePluginTools ?? [], gateway.logs()).toHaveLength(toolCount);
    }
  }, WAIT_OPTIONS);
  if (!node) {
    throw new Error(`node ${nodeId} did not connect:\n${gateway.logs()}`);
  }
  return node;
}

export function parseProbeResult(value: unknown): ProbeResult {
  const payload = isRecord(value) && isRecord(value.payload) ? value.payload : value;
  if (!isRecord(payload) || !Array.isArray(payload.content)) {
    throw new Error(`MCP result omitted content: ${JSON.stringify(value)}`);
  }
  const text = payload.content.find(
    (item) => isRecord(item) && item.type === "text" && typeof item.text === "string",
  );
  if (!isRecord(text) || typeof text.text !== "string") {
    throw new Error(`MCP result omitted text: ${JSON.stringify(value)}`);
  }
  const parsed: unknown = JSON.parse(text.text);
  if (
    !isRecord(parsed) ||
    typeof parsed.label !== "string" ||
    typeof parsed.marker !== "string" ||
    typeof parsed.pid !== "number"
  ) {
    throw new Error(`MCP result had invalid probe data: ${text.text}`);
  }
  return { label: parsed.label, marker: parsed.marker, pid: parsed.pid };
}

export async function invokeNodeMcpPayload(params: {
  gateway: GatewayHandle;
  nodeId: string;
  descriptor: NodePluginToolDescriptor;
  marker: string;
}): Promise<unknown> {
  const mcp = params.descriptor.mcp;
  if (!mcp) {
    throw new Error(`node descriptor ${params.descriptor.name} omitted MCP routing`);
  }
  return await params.gateway.call(
    "node.invoke",
    {
      nodeId: params.nodeId,
      command: NODE_MCP_COMMAND,
      params: { server: mcp.server, tool: mcp.tool, arguments: { marker: params.marker } },
      timeoutMs: WAIT_TIMEOUT_MS,
      idempotencyKey: randomUUID(),
    },
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
}

export async function invokeNodeMcp(
  params: Parameters<typeof invokeNodeMcpPayload>[0],
): Promise<ProbeResult> {
  return parseProbeResult(await invokeNodeMcpPayload(params));
}

export function flattenEffectiveTools(result: ToolsEffectiveResult): EffectiveTool[] {
  return (result.groups ?? []).flatMap((group) => group.tools ?? []);
}

export function createMcpServers(params: {
  placement: "session" | "node";
  fixture: HttpFixture;
  stdioEnv: Record<string, string>;
  fixturePath: string;
  repoRoot: string;
}): Record<string, McpServerConfig> {
  const common = {
    connectionTimeoutMs: WAIT_TIMEOUT_MS,
    requestTimeoutMs: WAIT_TIMEOUT_MS,
    toolFilter: { include: ["parity_*"], exclude: ["*_hidden"] },
  };
  return {
    stdio: {
      ...common,
      transport: "stdio",
      command: process.execPath,
      args: [params.fixturePath, "stdio", "--label", `${params.placement}-stdio`],
      cwd: params.repoRoot,
      env: params.stdioEnv,
    },
    streamableHttp: {
      ...common,
      transport: "streamable-http",
      url: params.fixture.urls.streamableHttp,
    },
    sse: {
      ...common,
      transport: "sse",
      url: params.fixture.urls.sse,
    },
  };
}

export function expectedProbeResults(
  placement: "session" | "node",
  markerPrefix: string,
  httpPid: number,
  servers: readonly McpServerName[] = MCP_SERVERS,
) {
  return Object.fromEntries(
    servers.map((server) => [
      server,
      {
        label: `${placement}-${MCP_LABELS[server]}`,
        marker: `${markerPrefix}-${server}`,
        pid: server === "stdio" ? expect.any(Number) : httpPid,
      },
    ]),
  );
}
