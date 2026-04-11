import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBundleMcpHarness,
  makeTempDir,
  waitForFileText,
  writeBundleProbeMcpServer,
  writeClaudeBundle,
} from "./pi-bundle-mcp-test-harness.js";
import {
  __testing,
  disposeSessionMcpRuntime,
  getOrCreateSessionMcpRuntime,
  materializeBundleMcpToolsForRun,
} from "./pi-bundle-mcp-tools.js";
import type { SessionMcpRuntime } from "./pi-bundle-mcp-types.js";

afterEach(async () => {
  await cleanupBundleMcpHarness();
});

describe("session MCP runtime", () => {
  it("keeps colliding sanitized tool definitions stable across catalog order changes", async () => {
    function makeRuntime(
      tools: Array<{ toolName: string; description: string }>,
    ): SessionMcpRuntime {
      return {
        sessionId: "session-colliding-tools",
        workspaceDir: "/tmp",
        configFingerprint: "fingerprint",
        createdAt: 0,
        lastUsedAt: 0,
        markUsed: () => {},
        getCatalog: async () => ({
          version: 1,
          generatedAt: 0,
          servers: {
            collision: {
              serverName: "collision",
              launchSummary: "collision",
              toolCount: tools.length,
            },
          },
          tools: tools.map((tool) => ({
            serverName: "collision",
            safeServerName: "collision",
            toolName: tool.toolName,
            description: tool.description,
            inputSchema: {
              type: "object",
              properties: {
                toolName: { type: "string", const: tool.toolName },
              },
            },
            fallbackDescription: tool.description,
          })),
        }),
        callTool: async (_serverName, toolName) => ({
          content: [{ type: "text", text: toolName }],
          isError: false,
        }),
        dispose: async () => {},
      };
    }

    const catalogA = [
      { toolName: "alpha?", description: "question" },
      { toolName: "alpha!", description: "bang" },
    ];
    const catalogB = catalogA.toReversed();

    const materializedA = await materializeBundleMcpToolsForRun({
      runtime: makeRuntime(catalogA),
    });
    const materializedB = await materializeBundleMcpToolsForRun({
      runtime: makeRuntime(catalogB),
    });

    const summarizeTools = (runtime: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>>) =>
      runtime.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));

    expect(summarizeTools(materializedA)).toEqual(summarizeTools(materializedB));
    expect(summarizeTools(materializedA)).toEqual([
      {
        name: "collision__alpha-",
        description: "bang",
        parameters: {
          type: "object",
          properties: {
            toolName: { type: "string", const: "alpha!" },
          },
        },
      },
      {
        name: "collision__alpha--2",
        description: "question",
        parameters: {
          type: "object",
          properties: {
            toolName: { type: "string", const: "alpha?" },
          },
        },
      },
    ]);
  });

  it("reuses the same session runtime across repeated materialization", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const startupCounterPath = path.join(workspaceDir, "bundle-starts.txt");
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "bundle-probe");
    const serverScriptPath = path.join(pluginRoot, "servers", "bundle-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath, { startupCounterPath });
    await writeClaudeBundle({ pluginRoot, serverScriptPath });

    const runtimeA = await getOrCreateSessionMcpRuntime({
      sessionId: "session-a",
      sessionKey: "agent:test:session-a",
      workspaceDir,
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      },
    });
    const runtimeB = await getOrCreateSessionMcpRuntime({
      sessionId: "session-a",
      sessionKey: "agent:test:session-a",
      workspaceDir,
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      },
    });

    const materializedA = await materializeBundleMcpToolsForRun({ runtime: runtimeA });
    const materializedB = await materializeBundleMcpToolsForRun({
      runtime: runtimeB,
      reservedToolNames: ["builtin_tool"],
    });

    expect(runtimeA).toBe(runtimeB);
    expect(materializedA.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(materializedB.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(await fs.readFile(startupCounterPath, "utf8")).toBe("1");
    expect(__testing.getCachedSessionIds()).toEqual(["session-a"]);
  });

  it("recreates the session runtime after explicit disposal", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const startupCounterPath = path.join(workspaceDir, "bundle-starts.txt");
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "bundle-probe");
    const serverScriptPath = path.join(pluginRoot, "servers", "bundle-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath, { startupCounterPath });
    await writeClaudeBundle({ pluginRoot, serverScriptPath });

    const cfg = {
      plugins: {
        entries: {
          "bundle-probe": { enabled: true },
        },
      },
    };

    const runtimeA = await getOrCreateSessionMcpRuntime({
      sessionId: "session-b",
      sessionKey: "agent:test:session-b",
      workspaceDir,
      cfg,
    });
    await materializeBundleMcpToolsForRun({ runtime: runtimeA });
    await disposeSessionMcpRuntime("session-b");

    const runtimeB = await getOrCreateSessionMcpRuntime({
      sessionId: "session-b",
      sessionKey: "agent:test:session-b",
      workspaceDir,
      cfg,
    });
    await materializeBundleMcpToolsForRun({ runtime: runtimeB });

    expect(runtimeA).not.toBe(runtimeB);
    expect(await fs.readFile(startupCounterPath, "utf8")).toBe("2");
  });

  it("recreates the session runtime when MCP config changes", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const startupCounterPath = path.join(workspaceDir, "bundle-starts.txt");
    const serverScriptPath = path.join(workspaceDir, "servers", "configured-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath, { startupCounterPath });

    const runtimeA = await getOrCreateSessionMcpRuntime({
      sessionId: "session-c",
      sessionKey: "agent:test:session-c",
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              command: "node",
              args: [serverScriptPath],
              env: {
                BUNDLE_PROBE_TEXT: "FROM-CONFIG-A",
              },
            },
          },
        },
      },
    });
    const toolsA = await materializeBundleMcpToolsForRun({ runtime: runtimeA });
    const resultA = await toolsA.tools[0].execute(
      "call-configured-probe-a",
      {},
      undefined,
      undefined,
    );

    const runtimeB = await getOrCreateSessionMcpRuntime({
      sessionId: "session-c",
      sessionKey: "agent:test:session-c",
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              command: "node",
              args: [serverScriptPath],
              env: {
                BUNDLE_PROBE_TEXT: "FROM-CONFIG-B",
              },
            },
          },
        },
      },
    });
    const toolsB = await materializeBundleMcpToolsForRun({ runtime: runtimeB });
    const resultB = await toolsB.tools[0].execute(
      "call-configured-probe-b",
      {},
      undefined,
      undefined,
    );

    expect(runtimeA).not.toBe(runtimeB);
    expect(resultA.content[0]).toMatchObject({ type: "text", text: "FROM-CONFIG-A" });
    expect(resultB.content[0]).toMatchObject({ type: "text", text: "FROM-CONFIG-B" });
    expect(await fs.readFile(startupCounterPath, "utf8")).toBe("2");
  });

  it("disposes startup-in-flight runtimes without leaking MCP processes", async () => {
    vi.useRealTimers();
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const startupCounterPath = path.join(workspaceDir, "bundle-starts.txt");
    const pidPath = path.join(workspaceDir, "bundle.pid");
    const exitMarkerPath = path.join(workspaceDir, "bundle.exit");
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "bundle-probe");
    const serverScriptPath = path.join(pluginRoot, "servers", "bundle-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath, {
      startupCounterPath,
      startupDelayMs: 1_000,
      pidPath,
      exitMarkerPath,
    });
    await writeClaudeBundle({ pluginRoot, serverScriptPath });

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-d",
      sessionKey: "agent:test:session-d",
      workspaceDir,
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      },
    });

    const materializeResult = materializeBundleMcpToolsForRun({ runtime }).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await waitForFileText(pidPath);
    await disposeSessionMcpRuntime("session-d");

    const result = await materializeResult;
    if (result.status !== "rejected") {
      throw new Error("Expected bundle MCP materialization to reject after disposal");
    }
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toMatch(/disposed/);
    expect(await waitForFileText(exitMarkerPath)).toBe("exited");
    expect(await fs.readFile(startupCounterPath, "utf8")).toBe("1");
    expect(__testing.getCachedSessionIds()).not.toContain("session-d");
  });

  it("materialized disposal can retire a manager-owned runtime", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const startupCounterPath = path.join(workspaceDir, "bundle-starts.txt");
    const pidPath = path.join(workspaceDir, "bundle.pid");
    const exitMarkerPath = path.join(workspaceDir, "bundle.exit");
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "bundle-probe");
    const serverScriptPath = path.join(pluginRoot, "servers", "bundle-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath, {
      startupCounterPath,
      pidPath,
      exitMarkerPath,
    });
    await writeClaudeBundle({ pluginRoot, serverScriptPath });

    const runtimeA = await getOrCreateSessionMcpRuntime({
      sessionId: "session-e",
      sessionKey: "agent:test:session-e",
      workspaceDir,
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      },
    });
    const materialized = await materializeBundleMcpToolsForRun({
      runtime: runtimeA,
      disposeRuntime: async () => {
        await disposeSessionMcpRuntime("session-e");
      },
    });

    expect(materialized.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(await waitForFileText(pidPath)).toMatch(/^\d+$/);

    await materialized.dispose();

    expect(await waitForFileText(exitMarkerPath)).toBe("exited");
    expect(__testing.getCachedSessionIds()).not.toContain("session-e");

    const runtimeB = await getOrCreateSessionMcpRuntime({
      sessionId: "session-e",
      sessionKey: "agent:test:session-e",
      workspaceDir,
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      },
    });

    expect(runtimeB).not.toBe(runtimeA);
    await materializeBundleMcpToolsForRun({ runtime: runtimeB });
    expect(await fs.readFile(startupCounterPath, "utf8")).toBe("2");
  });
});
