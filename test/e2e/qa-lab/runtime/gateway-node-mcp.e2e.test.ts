import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { NodePluginToolDescriptor } from "../../../../packages/gateway-protocol/src/schema/nodes.js";
import { createSessionMcpRuntime } from "../../../../src/agents/agent-bundle-mcp-runtime.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  MCP_SERVERS,
  NODE_MCP_COMMAND,
  TEST_TIMEOUT_MS,
  WAIT_OPTIONS,
  approvePairing,
  createChildEnv,
  createMcpServers,
  expectedProbeResults,
  flattenEffectiveTools,
  invokeNodeMcp,
  invokeNodeMcpPayload,
  parseProbeResult,
  processIsAlive,
  readNode,
  startHttpFixture,
  startNodeProcess,
  stopChild,
  waitForNode,
  waitForProcessExit,
  type CapturedChild,
  type GatewayHandle,
  type HttpFixture,
  type ProbeResult,
  type ToolsEffectiveResult,
} from "./gateway-node-mcp.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const QA_AGENT_ID = "qa";

describe("Gateway and node-host MCP live process parity", () => {
  it(
    "connects, filters, inventories, invokes, withdraws, and cleans up all real transports",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const repoRoot = process.cwd();
      const taskRoot = tempDirs.make("openclaw-gateway-node-mcp-");
      const taskPath = (...parts: string[]) => path.join(taskRoot, ...parts);
      const nodeHome = taskPath("node", "home");
      const nodeStateDir = taskPath("node", "state");
      const nodeConfigPath = taskPath("node", "openclaw.json");
      const nodeTempDir = taskPath("node", "tmp");
      const sessionWorkspace = taskPath("session", "workspace");
      const sessionHome = taskPath("session", "home");
      const sessionTempDir = taskPath("session", "tmp");
      const fixturePath = path.join(
        repoRoot,
        "test/e2e/qa-lab/runtime/gateway-node-mcp.fixture.mjs",
      );
      await Promise.all(
        [nodeHome, nodeStateDir, nodeTempDir, sessionWorkspace, sessionHome, sessionTempDir].map(
          (dir) => fs.mkdir(dir, { recursive: true }),
        ),
      );

      let sessionHttpFixture: HttpFixture | undefined;
      let nodeHttpFixture: HttpFixture | undefined;
      const gatewayOwner = createQaGatewayChild();
      let gateway: GatewayHandle | undefined;
      let node: CapturedChild | undefined;
      let sessionRuntime: ReturnType<typeof createSessionMcpRuntime> | undefined;
      let proofError: unknown;
      const cleanupErrors: unknown[] = [];
      let phase = "setup";
      const diagnosticTimer = setTimeout(() => {
        process.stderr.write(
          `MCP parity E2E stalled during ${phase}\n${node?.logs() ?? "node not started"}\n${gateway?.logs() ?? "gateway not started"}\n`,
        );
      }, 150_000);
      diagnosticTimer.unref();

      try {
        const sessionEnv = createChildEnv({ home: sessionHome, tempDir: sessionTempDir });
        const nodeFixtureEnv = createChildEnv({ home: nodeHome, tempDir: nodeTempDir });
        phase = "starting HTTP MCP fixtures";
        [sessionHttpFixture, nodeHttpFixture] = await Promise.all([
          startHttpFixture({ fixturePath, labelPrefix: "session", env: sessionEnv }),
          startHttpFixture({ fixturePath, labelPrefix: "node", env: nodeFixtureEnv }),
        ]);
        const sessionMcpServers = createMcpServers({
          placement: "session",
          fixture: sessionHttpFixture,
          stdioEnv: sessionEnv,
          fixturePath,
          repoRoot,
        });
        const nodeMcpServers = createMcpServers({
          placement: "node",
          fixture: nodeHttpFixture,
          stdioEnv: nodeFixtureEnv,
          fixturePath,
          repoRoot,
        });

        const nodeConfig: OpenClawConfig = {
          gateway: { mode: "local" },
          plugins: { enabled: false },
          nodeHost: { mcp: { servers: nodeMcpServers }, skills: { enabled: false } },
        };
        await fs.writeFile(nodeConfigPath, `${JSON.stringify(nodeConfig, null, 2)}\n`, "utf8");

        phase = "starting Gateway";
        gateway = await gatewayOwner.start({
          repoRoot,
          command: {
            executablePath: process.execPath,
            argsPrefix: ["dist/index.js"],
            cwd: repoRoot,
            usePackagedPlugins: true,
          },
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          runtimeEnvPatch: {
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_PROVIDERS: "1",
            OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          },
          mutateConfig: (cfg) => {
            return {
              ...cfg,
              plugins: { enabled: false },
              mcp: { servers: sessionMcpServers },
              agents: {
                ...cfg.agents,
                entries: {
                  ...cfg.agents?.entries,
                  [QA_AGENT_ID]: {
                    ...cfg.agents?.entries?.[QA_AGENT_ID],
                    tools: {
                      ...cfg.agents?.entries?.[QA_AGENT_ID]?.tools,
                      profile: "full",
                    },
                  },
                },
              },
              gateway: {
                ...cfg.gateway,
                nodes: {
                  ...cfg.gateway?.nodes,
                  commands: { allow: [NODE_MCP_COMMAND] },
                  pairing: { ...cfg.gateway?.nodes?.pairing, autoApproveLocal: false },
                },
              },
            };
          },
        });

        const gatewayPort = Number(new URL(gateway.baseUrl).port);
        const nodeEnv = createChildEnv({
          home: nodeHome,
          tempDir: nodeTempDir,
          extra: {
            OPENCLAW_HOME: nodeHome,
            OPENCLAW_STATE_DIR: nodeStateDir,
            OPENCLAW_CONFIG_PATH: nodeConfigPath,
            OPENCLAW_GATEWAY_TOKEN: gateway.token,
            OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_PROVIDERS: "1",
          },
        });

        // The first connection persists the approved device identity; the restart initiates node pairing.
        phase = "approving node device identity";
        node = startNodeProcess(gatewayPort, nodeEnv);
        const nodeId = await approvePairing(gateway, "device");
        phase = "restarting node after device approval";
        await stopChild(node);
        node = startNodeProcess(gatewayPort, nodeEnv);
        phase = "approving node command surface";
        await approvePairing(gateway, "node", nodeId);

        phase = "waiting for node MCP publication";
        const published = (await waitForNode(gateway, nodeId, 3)).nodePluginTools ?? [];
        expect(
          published.map((tool) => ({
            pluginId: tool.pluginId,
            command: tool.command,
            server: tool.mcp?.server,
            tool: tool.mcp?.tool,
          })),
        ).toEqual(
          MCP_SERVERS.map((server) => ({
            pluginId: "node-mcp",
            command: NODE_MCP_COMMAND,
            server,
            tool: "parity_probe",
          })),
        );

        phase = "loading session MCP catalog";
        sessionRuntime = createSessionMcpRuntime({
          sessionId: `qa-mcp-parity-${randomUUID()}`,
          sessionKey: `agent:${QA_AGENT_ID}:qa-mcp-parity-${randomUUID()}`,
          workspaceDir: sessionWorkspace,
          cfg: { plugins: { enabled: false }, mcp: { servers: sessionMcpServers } },
        });
        const catalog = await sessionRuntime.getCatalog();
        expect(
          catalog.tools
            .map((tool) => [tool.serverName, tool.toolName] as const)
            .toSorted(([left], [right]) => left.localeCompare(right)),
        ).toEqual(MCP_SERVERS.map((server) => [server, "parity_probe"]));

        phase = "calling node MCP tools";
        const nodeResults = new Map<string, ProbeResult>();
        for (const descriptor of published) {
          const server = descriptor.mcp?.server;
          if (!server) {
            throw new Error(`node MCP descriptor ${descriptor.name} omitted its server`);
          }
          nodeResults.set(
            server,
            await invokeNodeMcp({
              gateway,
              nodeId,
              descriptor,
              marker: `node-${server}`,
            }),
          );
        }

        phase = "calling session MCP tools";
        const sessionResults = new Map<string, ProbeResult>();
        for (const server of MCP_SERVERS) {
          sessionResults.set(
            server,
            parseProbeResult(
              await sessionRuntime.callTool(server, "parity_probe", {
                marker: `session-${server}`,
              }),
            ),
          );
        }

        expect(Object.fromEntries(nodeResults)).toEqual(
          expectedProbeResults("node", "node", nodeHttpFixture.pid),
        );
        expect(Object.fromEntries(sessionResults)).toEqual(
          expectedProbeResults("session", "session", sessionHttpFixture.pid),
        );
        expect(nodeHttpFixture.pid).not.toBe(sessionHttpFixture.pid);
        expect(nodeResults.get("stdio")?.pid).not.toBe(sessionResults.get("stdio")?.pid);

        const nodeStreamable = published.find(
          (descriptor) => descriptor.mcp?.server === "streamableHttp",
        );
        if (!nodeStreamable) {
          throw new Error("node Streamable HTTP descriptor was not published");
        }
        phase = "preserving MCP application errors";
        const nodeError = await invokeNodeMcpPayload({
          gateway,
          nodeId,
          descriptor: nodeStreamable,
          marker: "error-node-streamableHttp",
        });
        expect(nodeError).toMatchObject({
          ok: true,
          payload: {
            isError: true,
            structuredContent: {
              marker: "error-node-streamableHttp",
              retryable: true,
            },
          },
        });
        await expect(
          sessionRuntime.callTool("streamableHttp", "parity_probe", {
            marker: "error-session-streamableHttp",
          }),
        ).resolves.toMatchObject({
          isError: true,
          structuredContent: {
            marker: "error-session-streamableHttp",
            retryable: true,
          },
        });

        phase = "rotating node MCP catalog";
        await invokeNodeMcp({
          gateway,
          nodeId,
          descriptor: nodeStreamable,
          marker: "rotate-remove",
        });
        let rotatedPublished: NodePluginToolDescriptor[] = [];
        const catalogGateway = gateway;
        await vi.waitFor(async () => {
          rotatedPublished = (await readNode(catalogGateway, nodeId))?.nodePluginTools ?? [];
          expect(
            rotatedPublished.map((descriptor) => [descriptor.mcp?.server, descriptor.mcp?.tool]),
            catalogGateway.logs(),
          ).toEqual([
            ["sse", "parity_probe"],
            ["stdio", "parity_probe"],
            ["streamableHttp", "parity_rotated"],
          ]);
        }, WAIT_OPTIONS);
        const rotatedNodeStreamable = rotatedPublished.find(
          (descriptor) => descriptor.mcp?.server === "streamableHttp",
        );
        expect(rotatedNodeStreamable?.parameters).toMatchObject({
          properties: { revision: { type: "string" } },
        });
        for (const server of ["sse", "stdio"] as const) {
          const descriptor = rotatedPublished.find((candidate) => candidate.mcp?.server === server);
          if (!descriptor) {
            throw new Error(`healthy sibling ${server} disappeared during catalog rotation`);
          }
          await expect(
            invokeNodeMcp({
              gateway,
              nodeId,
              descriptor,
              marker: `node-after-rotation-${server}`,
            }),
          ).resolves.toMatchObject({ marker: `node-after-rotation-${server}` });
        }

        phase = "rotating session MCP catalog";
        await sessionRuntime.callTool("streamableHttp", "parity_probe", {
          marker: "rotate-remove",
        });
        await vi.waitFor(async () => {
          const refreshed = await sessionRuntime?.getCatalog();
          expect(
            refreshed?.tools
              .filter((entry) => entry.serverName === "streamableHttp")
              .map((entry) => entry.toolName),
          ).toEqual(["parity_rotated"]);
        }, WAIT_OPTIONS);
        await expect(
          sessionRuntime.callTool("streamableHttp", "parity_rotated", {
            marker: "session-after-rotation",
          }),
        ).resolves.toBeDefined();

        phase = "expiring node Streamable HTTP session";
        if (!rotatedNodeStreamable) {
          throw new Error("rotated node Streamable HTTP descriptor was not published");
        }
        await expect(
          invokeNodeMcp({
            gateway,
            nodeId,
            descriptor: rotatedNodeStreamable,
            marker: "expire-session",
          }),
        ).rejects.toThrow();
        await waitForNode(gateway, nodeId, 2);
        const recoveredPublished = (await waitForNode(gateway, nodeId, 3)).nodePluginTools ?? [];
        const recoveredStreamable = recoveredPublished.find(
          (descriptor) => descriptor.mcp?.server === "streamableHttp",
        );
        if (!recoveredStreamable) {
          throw new Error("node Streamable HTTP descriptor was not republished");
        }
        await expect(
          invokeNodeMcp({
            gateway,
            nodeId,
            descriptor: recoveredStreamable,
            marker: "node-after-session-expiry",
          }),
        ).resolves.toMatchObject({ marker: "node-after-session-expiry" });
        rotatedPublished = recoveredPublished;

        phase = "reading effective MCP inventory";
        const created = (await gateway.call("sessions.create", {
          agentId: QA_AGENT_ID,
          label: "QA MCP parity inventory",
        })) as { key?: string };
        if (!created.key) {
          throw new Error("sessions.create did not return a session key");
        }
        const effective = (await gateway.call("tools.effective", {
          sessionKey: created.key,
        })) as ToolsEffectiveResult;
        const effectiveNodeTools = flattenEffectiveTools(effective).filter(
          (tool) => tool.pluginId === "node-mcp" && tool.source === "mcp",
        );
        expect(
          effectiveNodeTools
            .map((tool) => tool.id)
            .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
        ).toEqual(rotatedPublished.map((tool) => tool.name).toSorted((a, b) => a.localeCompare(b)));

        phase = "withdrawing node stdio MCP tool";
        const nodeStdioPid = nodeResults.get("stdio")?.pid;
        if (!nodeStdioPid) {
          throw new Error("node stdio probe did not return its PID");
        }
        process.kill(nodeStdioPid, "SIGTERM");
        await waitForProcessExit(nodeStdioPid);
        const remaining = (await waitForNode(gateway, nodeId, 2)).nodePluginTools ?? [];
        expect(
          remaining
            .map((tool) => tool.mcp?.server)
            .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
        ).toEqual(["sse", "streamableHttp"]);
        const remainingResults = new Map<string, ProbeResult>();
        for (const descriptor of remaining) {
          const server = descriptor.mcp?.server;
          if (!server) {
            throw new Error(`remaining descriptor ${descriptor.name} omitted its server`);
          }
          const result = await invokeNodeMcp({
            gateway,
            nodeId,
            descriptor,
            marker: `node-after-stdio-stop-${server}`,
          });
          remainingResults.set(server, result);
        }
        expect(Object.fromEntries(remainingResults)).toEqual(
          expectedProbeResults("node", "node-after-stdio-stop", nodeHttpFixture.pid, [
            "sse",
            "streamableHttp",
          ]),
        );
        phase = "waiting for node stdio MCP recovery";
        const recoveredAfterStdio = (await waitForNode(gateway, nodeId, 3)).nodePluginTools ?? [];
        const recoveredStdio = recoveredAfterStdio.find(
          (descriptor) => descriptor.mcp?.server === "stdio",
        );
        if (!recoveredStdio) {
          throw new Error("node stdio MCP descriptor was not republished");
        }
        const recoveredStdioResult = await invokeNodeMcp({
          gateway,
          nodeId,
          descriptor: recoveredStdio,
          marker: "node-after-stdio-recovery",
        });
        expect(recoveredStdioResult.marker).toBe("node-after-stdio-recovery");
        expect(recoveredStdioResult.pid).not.toBe(nodeStdioPid);

        phase = "disposing session MCP runtime";
        const sessionStdioPid = sessionResults.get("stdio")?.pid;
        await sessionRuntime.dispose();
        sessionRuntime = undefined;
        if (sessionStdioPid) {
          await waitForProcessExit(sessionStdioPid);
        }

        phase = "stopping node host";
        await stopChild(node);
        node = undefined;
        const activeGateway = gateway;
        await vi.waitFor(async () => {
          const disconnected = await readNode(activeGateway, nodeId);
          expect(disconnected, activeGateway.logs()).toMatchObject({ connected: false });
          expect(disconnected?.nodePluginTools ?? []).toEqual([]);
        }, WAIT_OPTIONS);

        const afterNodeStop = (await gateway.call("tools.effective", {
          sessionKey: created.key,
        })) as ToolsEffectiveResult;
        expect(
          flattenEffectiveTools(afterNodeStop).filter((tool) => tool.pluginId === "node-mcp"),
        ).toEqual([]);
        expect([sessionHttpFixture.pid, nodeHttpFixture.pid].every(processIsAlive)).toBe(true);

        phase = "stopping HTTP MCP fixtures";
        const httpPids = [sessionHttpFixture.pid, nodeHttpFixture.pid];
        await Promise.all([stopChild(sessionHttpFixture), stopChild(nodeHttpFixture)]);
        sessionHttpFixture = undefined;
        nodeHttpFixture = undefined;
        await Promise.all(httpPids.map(waitForProcessExit));
      } catch (error) {
        const message = error instanceof Error ? error.stack : String(error);
        proofError = new Error(`${message}\nnode logs:\n${node?.logs() ?? "not started"}`, {
          cause: error,
        });
      } finally {
        phase = "cleanup";
        const cleanup = [
          ...(await Promise.allSettled([
            ...(sessionRuntime ? [sessionRuntime.dispose()] : []),
            ...(node ? [stopChild(node)] : []),
          ])),
          ...(await Promise.allSettled([
            stopQaGatewayFixture(gatewayOwner),
            ...(sessionHttpFixture ? [stopChild(sessionHttpFixture)] : []),
            ...(nodeHttpFixture ? [stopChild(nodeHttpFixture)] : []),
          ])),
        ];
        for (const result of cleanup) {
          if (result.status === "rejected") {
            cleanupErrors.push(result.reason);
          }
        }
        if (gateway && existsSync(gateway.tempRoot)) {
          cleanupErrors.push(new Error(`Gateway temp root was not removed: ${gateway.tempRoot}`));
        }
        clearTimeout(diagnosticTimer);
      }

      const failures = proofError === undefined ? cleanupErrors : [proofError, ...cleanupErrors];
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Gateway/node MCP parity proof failed");
      }
    },
  );
});
