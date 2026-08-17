// MCP CLI tests cover MCP command registration and server configuration behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withTempHome } from "../config/home-env.test-harness.js";
import {
  cleanupMcpCliTestState,
  createWorkspace,
  lastErrorLine,
  lastLogLine,
  mockError,
  mockLog,
  readMcpOAuthCredentialsStatus,
  resetMcpCliTestState,
  runMcpCommand,
  setCreateSessionMcpRuntimeOverride,
  serveOpenClawChannelMcp,
} from "./mcp-cli.test-harness.js";
import { writeProbeMcpServer } from "./mcp-cli.test-support.js";
import { runCliWithExitFinalization } from "./one-shot-exit.js";

describe("mcp cli", () => {
  beforeEach(() => {
    resetMcpCliTestState();
  });

  afterEach(async () => {
    await cleanupMcpCliTestState();
  });

  it("sets and shows a configured MCP server", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async (home) => {
      const workspaceDir = await createWorkspace();
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand(["mcp", "set", "context7", '{"command":"uvx","args":["context7-mcp"]}']);
      expect(lastLogLine()).toBe(`Saved MCP server "context7" to ${configPath}.`);

      mockLog.mockClear();
      await runMcpCommand(["mcp", "show", "context7", "--json"]);
      expect(JSON.parse(lastLogLine())).toEqual({ command: "uvx", args: ["context7-mcp"] });
    });
  });

  it("adds a configured MCP server from flags without replacing operator knobs", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "add",
        "docs",
        "--url",
        "https://mcp.example.com/mcp",
        "--transport",
        "streamable-http",
        "--header",
        "Authorization=Bearer token",
        "--auth",
        "oauth",
        "--oauth-scope",
        "docs.read",
        "--include",
        "search,read_*",
        "--timeout",
        "12",
        "--connect-timeout",
        "3",
        "--parallel",
        "--approval",
        "approve",
        "--no-probe",
      ]);

      mockLog.mockClear();
      await runMcpCommand(["mcp", "show", "docs", "--json"]);
      expect(JSON.parse(lastLogLine())).toEqual({
        url: "https://mcp.example.com/mcp",
        transport: "streamable-http",
        headers: { Authorization: "Bearer token" },
        auth: "oauth",
        oauth: { scope: "docs.read" },
        toolFilter: { include: ["search", "read_*"] },
        requestTimeoutMs: 12_000,
        connectionTimeoutMs: 3_000,
        supportsParallelToolCalls: true,
        codex: { defaultToolsApprovalMode: "approve" },
      });
    });
  });

  it("updates approval mode without replacing saved Codex metadata", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        JSON.stringify({
          command: process.execPath,
          codex: { agents: ["docs-agent"], defaultToolsApprovalMode: "auto" },
        }),
      ]);

      await runMcpCommand(["mcp", "configure", "docs", "--approval", "approve"]);

      mockLog.mockClear();
      await runMcpCommand(["mcp", "show", "docs", "--json"]);
      expect(JSON.parse(lastLogLine())).toEqual({
        command: process.execPath,
        codex: { agents: ["docs-agent"], defaultToolsApprovalMode: "approve" },
      });
    });
  });

  it("rejects hexadecimal MCP timeout options before writing configuration", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async (home) => {
      const workspaceDir = await createWorkspace();
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await expect(
        runMcpCommand([
          "mcp",
          "add",
          "docs",
          "--url",
          "https://mcp.example.com/mcp",
          "--timeout",
          "0x10",
          "--no-probe",
        ]),
      ).rejects.toThrow("__exit__:1");
      expect(lastErrorLine()).toBe("--timeout must be a positive number.");
      await expect(fs.readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","requestTimeoutMs":12000}',
      ]);
      mockError.mockClear();

      await expect(
        runMcpCommand(["mcp", "configure", "docs", "--connect-timeout", "0x3"]),
      ).rejects.toThrow("__exit__:1");
      expect(lastErrorLine()).toBe("--connect-timeout must be a positive number.");

      mockLog.mockClear();
      await runMcpCommand(["mcp", "show", "docs", "--json"]);
      expect(JSON.parse(lastLogLine())).toEqual({
        url: "https://mcp.example.com",
        requestTimeoutMs: 12_000,
      });
    });
  });

  it(
    "requires initialize to finish within the configured probe timeout before saving",
    { timeout: 10_000 },
    async () => {
      await withTempHome("openclaw-cli-mcp-home-", async (home) => {
        const workspaceDir = await createWorkspace();
        const serverPath = path.join(workspaceDir, "probe-server.mjs");
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        await writeProbeMcpServer(serverPath);
        vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

        const startedAt = performance.now();
        await expect(
          runMcpCommand([
            "mcp",
            "add",
            "hung",
            "--command",
            process.execPath,
            "--arg",
            serverPath,
            "--env",
            "MCP_MODE=hang-start",
            "--connect-timeout",
            "0.2",
          ]),
        ).rejects.toThrow("__exit__:1");
        const elapsedMs = performance.now() - startedAt;

        expect(elapsedMs).toBeGreaterThanOrEqual(100);
        expect(elapsedMs).toBeLessThan(1_500);
        expect(lastErrorLine()).toContain(
          'MCP server "hung" timed out: did not complete initialize within 0.2s',
        );
        await expect(fs.readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

        await runMcpCommand([
          "mcp",
          "add",
          "ok",
          "--command",
          process.execPath,
          "--arg",
          serverPath,
          "--env",
          "MCP_MODE=normal",
        ]);
        expect(lastLogLine()).toBe(`Saved MCP server "ok" to ${configPath}.`);

        await expect(
          runMcpCommand([
            "mcp",
            "add",
            "crash",
            "--command",
            process.execPath,
            "--arg",
            serverPath,
            "--env",
            "MCP_MODE=crash",
          ]),
        ).rejects.toThrow("__exit__:1");

        mockLog.mockClear();
        await runMcpCommand(["mcp", "list", "--json"]);
        const saved = JSON.parse(lastLogLine()) as Record<string, unknown>;
        expect(Object.keys(saved)).toEqual(["ok"]);
      });
    },
  );

  it("passes a five-second default initialize timeout to the probe runtime", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async (home) => {
      const workspaceDir = await createWorkspace();
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      let probeTimeoutMs: unknown;
      setCreateSessionMcpRuntimeOverride((params) => {
        probeTimeoutMs = params.cfg?.mcp?.servers?.["hung-default"]?.connectionTimeoutMs;
        return {
          sessionId: params.sessionId,
          workspaceDir: params.workspaceDir,
          configFingerprint: "cli-probe-test",
          createdAt: 0,
          lastUsedAt: 0,
          getCatalog: async () => ({
            version: 1,
            generatedAt: Date.now(),
            servers: {},
            tools: [],
            diagnostics: [
              {
                serverName: "hung-default",
                safeServerName: "hung-default",
                launchSummary: process.execPath,
                message:
                  'MCP server "hung-default" timed out: did not complete initialize within 5s',
              },
            ],
          }),
          peekCatalog: () => null,
          markUsed: () => {},
          callTool: async () => ({ content: [] }),
          dispose: async () => {},
        };
      });

      await expect(
        runMcpCommand(["mcp", "add", "hung-default", "--command", process.execPath]),
      ).rejects.toThrow("__exit__:1");

      expect(probeTimeoutMs).toBe(5_000);
      expect(lastErrorLine()).toContain(
        'MCP server "hung-default" timed out: did not complete initialize within 5s',
      );
      await expect(fs.readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("labels listed MCP servers as OpenClaw-managed", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand(["mcp", "set", "context7", '{"command":"uvx","args":["context7-mcp"]}']);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "list"]);

      const output = mockLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("OpenClaw-managed MCP servers (");
      expect(output).toContain("- context7");
      expect(output).toContain("OpenClaw-managed mcp.servers entries");
      expect(output).toContain("does not include mcporter servers from config/mcporter.json");
    });
  });

  it("updates per-server MCP tool filters", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async (home) => {
      const workspaceDir = await createWorkspace();
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand(["mcp", "set", "docs", '{"command":"node","args":["server.mjs"]}']);
      await runMcpCommand([
        "mcp",
        "tools",
        "docs",
        "--include",
        "search,read_*",
        "--exclude",
        "admin_*",
      ]);

      expect(lastLogLine()).toBe(`Updated MCP tool selection for "docs" in ${configPath}.`);

      mockLog.mockClear();
      await runMcpCommand(["mcp", "show", "docs", "--json"]);
      expect(JSON.parse(lastLogLine()).toolFilter).toEqual({
        include: ["read_*", "search"],
        exclude: ["admin_*"],
      });
    });
  });

  it("requires an explicit MCP tool filter operation", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand(["mcp", "set", "docs", '{"command":"node","args":["server.mjs"]}']);
      await expect(runMcpCommand(["mcp", "tools", "docs"])).rejects.toThrow("__exit__:1");

      expect(lastErrorLine()).toBe("Specify --include, --exclude, or --clear.");
    });
  });

  it("clears per-server MCP tool filters only when requested", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand(["mcp", "set", "docs", '{"command":"node","args":["server.mjs"]}']);
      await runMcpCommand(["mcp", "tools", "docs", "--include", "search"]);
      await runMcpCommand(["mcp", "tools", "docs", "--clear"]);

      mockLog.mockClear();
      await runMcpCommand(["mcp", "show", "docs", "--json"]);
      expect(JSON.parse(lastLogLine())).not.toHaveProperty("toolFilter");
    });
  });

  it("shows MCP transport status without connecting", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","transport":"streamable-http"}',
      ]);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "status", "--json"]);

      expect(JSON.parse(lastLogLine()).servers).toEqual([
        {
          name: "docs",
          configured: true,
          enabled: true,
          ok: true,
          transport: "streamable-http",
          launch: "https://mcp.example.com",
          requestTimeoutMs: 60_000,
          connectionTimeoutMs: 30_000,
          supportsParallelToolCalls: false,
        },
      ]);
    });
  });

  it("redacts stdio argv credentials from MCP status output", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "local",
        '{"command":"node","args":["server.mjs","--api-key","test-api-key","--token=test-token"]}',
      ]);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "status", "--json"]);
      const jsonOutput = lastLogLine();
      expect(jsonOutput).not.toContain("test-api-key");
      expect(jsonOutput).not.toContain("test-token");
      expect(JSON.parse(jsonOutput).servers[0].launch).toBe(
        "node server.mjs --api-key *** --token=***",
      );

      mockLog.mockClear();
      await runMcpCommand(["mcp", "status", "--verbose"]);
      const verboseOutput = mockLog.mock.calls.map(([line]) => String(line)).join("\n");
      expect(verboseOutput).toContain("launch: node server.mjs --api-key *** --token=***");
      expect(verboseOutput).not.toContain("test-api-key");
      expect(verboseOutput).not.toContain("test-token");
    });
  });

  it("reports MCP doctor setup errors and sensitive literals", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"command":"./missing-mcp","env":{"DOCS_API_KEY":"literal"},"headers":{"Authorization":"Bearer literal"}}',
      ]);
      mockLog.mockClear();

      await expect(runMcpCommand(["mcp", "doctor", "--json"])).rejects.toThrow("__exit__:1");

      const result = JSON.parse(lastLogLine());
      expect(result.ok).toBe(false);
      expect(lastErrorLine()).toBe("MCP doctor found errors.");
      expect(result.servers[0]).toMatchObject({ name: "docs", ok: false });
      expect(result.servers[0].issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "error",
            message: "stdio command not found or not executable: ./missing-mcp",
          }),
          expect.objectContaining({
            level: "warning",
            message: expect.stringContaining("env.DOCS_API_KEY contains a literal sensitive value"),
          }),
          expect.objectContaining({
            level: "warning",
            message: expect.stringContaining(
              "headers.Authorization contains a literal sensitive value",
            ),
          }),
        ]),
      );
    });
  });

  it("bounds concurrent MCP doctor server checks", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      for (let index = 0; index < 6; index += 1) {
        await runMcpCommand([
          "mcp",
          "set",
          `server-${index}`,
          JSON.stringify({
            url: `https://mcp-${index}.example.com`,
            transport: "streamable-http",
            auth: "oauth",
          }),
        ]);
      }

      const checksBlocked = createDeferred();
      readMcpOAuthCredentialsStatus.mockImplementation(async () => {
        await checksBlocked.promise;
        return {
          state: "unauthenticated",
        };
      });

      const doctorPromise = runMcpCommand(["mcp", "doctor", "--json"]);
      await vi.waitFor(() => {
        expect(readMcpOAuthCredentialsStatus.mock.calls.length).toBeGreaterThanOrEqual(4);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const startedBeforeRelease = readMcpOAuthCredentialsStatus.mock.calls.length;
      checksBlocked.resolve();
      await doctorPromise;

      expect(readMcpOAuthCredentialsStatus).toHaveBeenCalledTimes(6);
      expect(startedBeforeRelease).toBe(4);
      expect(
        JSON.parse(lastLogLine()).servers.map((server: { name: string }) => server.name),
      ).toEqual(["server-0", "server-1", "server-2", "server-3", "server-4", "server-5"]);
    });
  });

  it("surfaces unexpected MCP doctor check errors", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","transport":"streamable-http","auth":"oauth"}',
      ]);
      readMcpOAuthCredentialsStatus.mockRejectedValueOnce(new Error("credential store failed"));

      await expect(runMcpCommand(["mcp", "doctor", "--json"])).rejects.toThrow(
        "credential store failed",
      );
    });
  });

  it("does not fail MCP doctor for disabled-only overrides", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"enabled":false,"env":{"DOCS_API_KEY":"literal"},"headers":{"Authorization":"Bearer literal"}}',
      ]);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "doctor", "--json"]);

      expect(JSON.parse(lastLogLine())).toMatchObject({
        ok: true,
        servers: [
          {
            name: "docs",
            ok: true,
            issues: expect.arrayContaining([
              { level: "warning", message: "server is disabled" },
              expect.objectContaining({
                level: "warning",
                message: expect.stringContaining(
                  "env.DOCS_API_KEY contains a literal sensitive value",
                ),
              }),
              expect.objectContaining({
                level: "warning",
                message: expect.stringContaining(
                  "headers.Authorization contains a literal sensitive value",
                ),
              }),
            ]),
          },
        ],
      });
    });
  });

  it("uses configured PATH when checking MCP stdio commands", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      const binDir = path.join(workspaceDir, "bin");
      const commandPath = path.join(binDir, "docs-mcp");
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf-8");
      await fs.chmod(commandPath, 0o755);
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        JSON.stringify({ command: "docs-mcp", env: { PATH: binDir } }),
      ]);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "doctor", "--json"]);

      expect(JSON.parse(lastLogLine())).toMatchObject({
        ok: true,
        servers: [{ name: "docs", ok: true, issues: [] }],
      });
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not treat Path as PATH when checking MCP stdio commands",
    async () => {
      await withTempHome("openclaw-cli-mcp-home-", async () => {
        const workspaceDir = await createWorkspace();
        const binDir = path.join(workspaceDir, "bin");
        const commandPath = path.join(binDir, "mis-cased-path-mcp");
        await fs.mkdir(binDir, { recursive: true });
        await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf-8");
        await fs.chmod(commandPath, 0o755);
        vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

        await runMcpCommand([
          "mcp",
          "set",
          "docs",
          JSON.stringify({ command: "mis-cased-path-mcp", env: { Path: binDir } }),
        ]);
        mockLog.mockClear();

        await expect(runMcpCommand(["mcp", "doctor", "--json"])).rejects.toThrow("__exit__:1");

        expect(JSON.parse(lastLogLine())).toMatchObject({
          ok: false,
          servers: [
            {
              name: "docs",
              ok: false,
              issues: [
                {
                  level: "error",
                  message: "stdio command not found or not executable: mis-cased-path-mcp",
                },
              ],
            },
          ],
        });
      });
    },
  );

  it("resolves relative configured PATH entries from the MCP stdio cwd", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      const appDir = path.join(workspaceDir, "app");
      const binDir = path.join(appDir, "node_modules", ".bin");
      const commandPath = path.join(binDir, "docs-mcp");
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf-8");
      await fs.chmod(commandPath, 0o755);
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        JSON.stringify({
          command: "docs-mcp",
          cwd: appDir,
          env: { PATH: "node_modules/.bin" },
        }),
      ]);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "doctor", "--json"]);

      expect(JSON.parse(lastLogLine())).toMatchObject({
        ok: true,
        servers: [{ name: "docs", ok: true, issues: [] }],
      });
    });
  });

  it("removes pure disabled tombstones when enabling MCP servers", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand(["mcp", "set", "bundleProbe", '{"enabled":false}']);
      await runMcpCommand(["mcp", "configure", "bundleProbe", "--enable"]);

      mockLog.mockClear();
      await runMcpCommand(["mcp", "list"]);
      const output = mockLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("No OpenClaw-managed MCP servers configured in ");
      expect(output).toContain("does not include mcporter servers from config/mcporter.json");
    });
  });

  it("fails named probes for disabled MCP servers", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async (home) => {
      const workspaceDir = await createWorkspace();
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand(["mcp", "set", "docs", '{"enabled":false}']);

      await expect(runMcpCommand(["mcp", "probe", "docs"])).rejects.toThrow("__exit__:1");
      expect(lastErrorLine()).toBe(
        `MCP server "docs" is disabled in ${configPath}. Run openclaw mcp configure docs --enable before probing it.`,
      );
    });
  });

  it("reports omitted enabled servers while accepting omitted disabled servers", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async (home) => {
      const workspaceDir = await createWorkspace();
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      let catalogServers: Record<
        string,
        { serverName: string; launchSummary: string; toolCount: number }
      > = {};
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ mcp: { servers: { incomplete: { command: "node" } } } })}\n`,
        "utf8",
      );
      setCreateSessionMcpRuntimeOverride((params) => ({
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        configFingerprint: "cli-probe-test",
        createdAt: 0,
        lastUsedAt: 0,
        getCatalog: async () => ({
          version: 1,
          generatedAt: Date.now(),
          servers: catalogServers,
          tools: [],
          diagnostics: [],
        }),
        peekCatalog: () => null,
        markUsed: () => {},
        callTool: async () => ({ content: [] }),
        dispose: async () => {},
      }));

      mockError.mockClear();
      await runCliWithExitFinalization({
        run: () => runMcpCommand(["mcp", "probe", "--json"]),
        onError: (error) => {
          throw error;
        },
      });

      expect(JSON.parse(lastLogLine())).toMatchObject({ servers: {}, diagnostics: [] });
      expect(lastErrorLine()).toBe(`MCP probe did not connect to "incomplete" in ${configPath}.`);

      await fs.writeFile(
        configPath,
        `${JSON.stringify({
          mcp: {
            servers: {
              healthy: { command: "node" },
              disabled: { enabled: false },
            },
          },
        })}\n`,
        "utf8",
      );
      catalogServers = {
        healthy: { serverName: "healthy", launchSummary: "node", toolCount: 1 },
      };
      mockError.mockClear();
      mockLog.mockClear();

      await runCliWithExitFinalization({
        run: () => runMcpCommand(["mcp", "probe", "--json"]),
        onError: (error) => {
          throw error;
        },
      });

      expect(JSON.parse(lastLogLine())).toMatchObject({
        servers: { healthy: { tools: 1 } },
        diagnostics: [],
      });
      expect(lastErrorLine()).toBe("");
    });
  });

  it("warns when auto-approved Codex MCP tools have no safety annotations", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      await runMcpCommand(["mcp", "set", "memory", JSON.stringify({ command: process.execPath })]);
      setCreateSessionMcpRuntimeOverride((params) => ({
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        configFingerprint: "cli-probe-approval-hint",
        createdAt: 0,
        lastUsedAt: 0,
        getCatalog: async () => ({
          version: 1,
          generatedAt: Date.now(),
          servers: {
            memory: {
              serverName: "memory",
              launchSummary: process.execPath,
              toolCount: 1,
              codexApprovalMode: "auto",
            },
          },
          tools: [
            {
              serverName: "memory",
              safeServerName: "memory",
              toolName: "create_entities",
              inputSchema: { type: "object" },
              fallbackDescription: "Create entities",
              codexAnnotations: {},
            },
          ],
          diagnostics: [],
        }),
        peekCatalog: () => null,
        markUsed: () => {},
        callTool: async () => ({ content: [] }),
        dispose: async () => {},
      }));

      mockLog.mockClear();
      await runMcpCommand(["mcp", "probe", "memory"]);
      expect(mockLog.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
        "tools have no safety annotations; calls will require interactive approval",
      );

      mockLog.mockClear();
      await runMcpCommand(["mcp", "doctor", "memory", "--probe"]);
      expect(mockLog.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
        "tools have no safety annotations; calls will require interactive approval",
      );
    });
  });

  it("fails when removing an unknown MCP server", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async (home) => {
      const workspaceDir = await createWorkspace();
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await expect(runMcpCommand(["mcp", "unset", "missing"])).rejects.toThrow("__exit__:1");
      expect(lastErrorLine()).toBe(
        `No MCP server named "missing" in ${configPath}. Run openclaw mcp list to see configured servers.`,
      );
    });
  });

  it("starts the channel bridge with parsed serve options", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      const tokenFile = path.join(workspaceDir, "gateway.token");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      await fs.writeFile(tokenFile, "secret-token\n", "utf-8");

      await runMcpCommand([
        "mcp",
        "serve",
        "--url",
        "ws://127.0.0.1:18789",
        "--token-file",
        tokenFile,
        "--claude-channel-mode",
        "on",
        "--verbose",
      ]);

      expect(serveOpenClawChannelMcp).toHaveBeenCalledWith({
        gatewayUrl: "ws://127.0.0.1:18789",
        gatewayToken: "secret-token",
        gatewayPassword: undefined,
        claudeChannelMode: "on",
        verbose: true,
      });
    });
  });
});
