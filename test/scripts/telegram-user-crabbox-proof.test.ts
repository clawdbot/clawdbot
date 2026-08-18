// Telegram User Crabbox Proof tests cover telegram user crabbox proof script behavior.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_TIMEOUT_MS,
  createContainerizedSutSpawnSpec,
  createCrabboxWarmupArgs,
  createOpenClawCliSpawnSpec,
  createOpenClawGatewaySpawnSpec,
  parseArgs,
  processTargetExists,
  readCodexProxyPort,
  readLogAfterOffset,
  readLogTail,
  readTelegramUserProofLogTailBytes,
  recordProbeVideo,
  resolveTelegramUserProofCredentialRole,
  REMOTE_SETUP_COMMAND_TIMEOUT_MS,
  renderLaunchDesktop,
  renderRemoteProbe,
  renderRemoteSetup,
  renderSelectDesktopChat,
  renderTailscaleSshProxy,
  restartSessionGateway,
  runCommand,
  runSutContainerAction,
  selectCrabboxSshPort,
  signalPidTree,
  stageFullSessionArtifacts,
  startLocalSut,
  waitForLog,
  waitForLogAfterOffset,
  writeSutConfig,
} from "../../scripts/e2e/telegram-user-crabbox-proof.ts";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];
const posixIt = process.platform === "win32" ? it.skip : it;
// Proof subprocesses expose explicit ready files; the timeout only bounds broken fixtures and
// must leave headroom for cold tsx startup on loaded maintainer hosts.
const PROCESS_READY_TIMEOUT_MS = 30_000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function writeExecutable(pathname: string, content: string): void {
  fs.writeFileSync(pathname, content, { mode: 0o755 });
}

function runProofCli(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/e2e/telegram-user-crabbox-proof.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = PROCESS_READY_TIMEOUT_MS,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(5);
  }
  throw new Error("condition was not met before timeout");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cleanupTempDirs(tempDirs);
});

describe("telegram user Crabbox proof log polling", () => {
  it("starts the local gateway through the repo pnpm runner", () => {
    const root = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    const fakePnpm = path.join(root, "pnpm.cjs");
    fs.writeFileSync(fakePnpm, "#!/usr/bin/env node\n", { mode: 0o755 });

    const spec = createOpenClawGatewaySpawnSpec({
      env: { ...process.env, OPENCLAW_TELEGRAM_PROOF_SENTINEL: "1" },
      gatewayPort: 19042,
      nodeExecPath: "/opt/node/bin/node",
      npmExecPath: fakePnpm,
      repoRoot: root,
    });

    expect(spec.command).toBe("/opt/node/bin/node");
    expect(spec.args).toEqual([fakePnpm, "openclaw", "gateway", "--port", "19042"]);
    expect(spec.options.cwd).toBe(root);
    expect(spec.options.env?.OPENCLAW_TELEGRAM_PROOF_SENTINEL).toBe("1");
    expect(spec.options.shell).toBe(false);
  });

  it("uses an explicitly pinned pnpm executable for a worktree gateway", () => {
    const spec = createOpenClawGatewaySpawnSpec({
      env: { PATH: "/definitely-missing" },
      gatewayPort: 19042,
      pnpmExecPath: "/opt/mantis-toolchain/pnpm",
      repoRoot: "/repo",
    });

    expect(spec.command).toBe("/opt/mantis-toolchain/pnpm");
    expect(spec.args).toEqual(["openclaw", "gateway", "--port", "19042"]);
    expect(spec.options.cwd).toBe("/repo");
    expect(spec.options.shell).toBe(false);
  });

  it("runs held-session audit inspection through the same pinned repo CLI", () => {
    const spec = createOpenClawCliSpawnSpec({
      args: ["audit", "--run", "run-1", "--explain", "--json"],
      env: { OPENCLAW_CONFIG_PATH: "/tmp/openclaw.json" },
      pnpmExecPath: "/opt/mantis-toolchain/pnpm",
      repoRoot: "/repo",
    });

    expect(spec.command).toBe("/opt/mantis-toolchain/pnpm");
    expect(spec.args).toEqual(["openclaw", "audit", "--run", "run-1", "--explain", "--json"]);
    expect(spec.options.env?.OPENCLAW_CONFIG_PATH).toBe("/tmp/openclaw.json");
  });

  it("routes fork SUT startup through the root-owned validating wrapper", () => {
    const repoRoot = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    const runtimeRoot = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    const spec = createContainerizedSutSpawnSpec({
      codexProxyPort: 43123,
      containerName: "openclaw-telegram-sut-test",
      gatewayEnv: {
        TELEGRAM_BOT_TOKEN: "telegram-burner-token",
      },
      gatewayPort: 19042,
      mockPort: 19043,
      mockResponseText: "streamed response",
      repoRoot,
      runtimeRoot,
      sutLane: "candidate",
    });

    expect(spec.command).toBe("sudo");
    expect(spec.args).toContain("/usr/local/sbin/openclaw-mantis-sut-container");
    expect(spec.args).toContain("run");
    expect(spec.args).toContain("candidate");
    expect(spec.args).not.toContain("docker");
    expect(spec.args.join("\n")).not.toContain("--preserve-env");
    expect(spec.args.join("\n")).not.toContain("CODEX_HOME");
    expect(spec.options.env).not.toHaveProperty("CODEX_HOME");
    expect(spec.options.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(spec.options.env).not.toHaveProperty("TELEGRAM_BOT_TOKEN");
    expect(fs.statSync(spec.inputPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(spec.inputPath, "utf8"))).toEqual({
      mockResponseText: "streamed response",
      telegramBotToken: "telegram-burner-token",
    });
  });

  it("reads only the loopback Responses proxy port from Codex config", () => {
    const codexHome = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      '[model_providers.codex-action-responses-proxy]\nbase_url = "http://127.0.0.1:43123/v1"\n',
    );
    expect(readCodexProxyPort(codexHome)).toBe(43123);
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      '[model_providers.codex-action-responses-proxy]\nbase_url = "https://api.openai.com/v1"\n',
    );
    expect(readCodexProxyPort(codexHome)).toBeUndefined();
  });

  it("requires successful privileged SUT teardown commands", () => {
    const run = vi.fn(() => ({ signal: null, status: 0, stderr: "" }));
    runSutContainerAction(
      "stop",
      "openclaw-telegram-sut-test",
      "/tmp/openclaw-tg-crabbox-sut-test",
      run,
    );
    expect(run).toHaveBeenCalledWith(
      "sudo",
      [
        "-n",
        "/usr/local/sbin/openclaw-mantis-sut-container",
        "stop",
        "openclaw-telegram-sut-test",
        "/tmp/openclaw-tg-crabbox-sut-test",
      ],
      expect.objectContaining({ encoding: "utf8", stdio: "pipe" }),
    );

    expect(() =>
      runSutContainerAction(
        "destroy",
        "openclaw-telegram-sut-test",
        "/tmp/openclaw-tg-crabbox-sut-test",
        () => ({ signal: null, status: 1, stderr: "destroy failed" }),
      ),
    ).toThrow("destroy failed with exit code 1.\ndestroy failed");
    expect(() =>
      runSutContainerAction(
        "stop",
        "openclaw-telegram-sut-test",
        "/tmp/openclaw-tg-crabbox-sut-test",
        () => ({ signal: "SIGKILL", status: null, stderr: "" }),
      ),
    ).toThrow("stop was terminated by SIGKILL");
    expect(() =>
      runSutContainerAction(
        "stop",
        "openclaw-telegram-sut-test",
        "/tmp/openclaw-tg-crabbox-sut-test",
        () => ({ error: new Error("spawn failed"), status: null }),
      ),
    ).toThrow("Failed to stop container-isolated SUT: spawn failed");
  });

  it("treats permission-denied process probes as alive", () => {
    const kill = vi.spyOn(process, "kill");
    kill.mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    expect(processTargetExists(1234)).toBe(true);

    kill.mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    expect(processTargetExists(1234)).toBe(false);

    kill.mockImplementation(() => {
      throw Object.assign(new Error("unexpected"), { code: "EINVAL" });
    });
    expect(() => processTargetExists(1234)).toThrow("unexpected");
  });

  it("forces fork candidates into the isolated SUT container", () => {
    vi.stubEnv("MANTIS_CANDIDATE_TRUST", "fork-pr-head");
    expect(() => parseArgs(["start"])).toThrow(
      "container proof requires --sut-repo-root and --sut-lane.",
    );
    expect(
      parseArgs(["start", "--sut-lane", "candidate", "--sut-repo-root", "/prepared/candidate"]),
    ).toMatchObject({
      sutContainer: true,
      sutLane: "candidate",
      sutRepoRoot: "/prepared/candidate",
    });
    expect(() => parseArgs([])).toThrow("--sut-container requires the held-session start flow.");
    vi.stubEnv("MANTIS_CANDIDATE_TRUST", "open-pr-head");
    expect(parseArgs(["start"]).sutContainer).toBe(false);
    expect(() => parseArgs(["start", "--sut-container"])).toThrow(
      "container proof requires --sut-repo-root and --sut-lane.",
    );
  });

  it("allows cold remote setup to outlive ordinary command timeouts", () => {
    expect(REMOTE_SETUP_COMMAND_TIMEOUT_MS).toBeGreaterThan(COMMAND_TIMEOUT_MS);
    expect(REMOTE_SETUP_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(90 * 60 * 1000);
  });

  it.each([
    {
      inspect: { sshFallbackPorts: ["22", "2222", " 2200 ", "22"], sshPort: "2222" },
      ports: ["2222", "22", "2200"],
    },
    {
      inspect: { sshFallbackPorts: ["2200", "22", "2200"] },
      ports: ["22", "2200"],
    },
    { inspect: {}, ports: ["22"] },
  ])("selects ordered, deduplicated SSH candidates: $ports", async ({ inspect, ports }) => {
    const probes: string[] = [];

    await expect(
      selectCrabboxSshPort({
        inspect,
        probe: async (port) => {
          probes.push(port);
          if (port !== ports.at(-1)) {
            throw new Error("Connection refused");
          }
        },
      }),
    ).resolves.toBe(ports.at(-1));
    expect(probes).toEqual(ports);
  });

  it("does not try a fallback after a non-connection failure", async () => {
    const probes: string[] = [];

    await expect(
      selectCrabboxSshPort({
        inspect: { sshFallbackPorts: ["22"], sshPort: "2222" },
        probe: async (port) => {
          probes.push(port);
          throw new Error("Permission denied (publickey)");
        },
      }),
    ).rejects.toThrow("Permission denied");
    expect(probes).toEqual(["2222"]);
  });

  it("rejects loose numeric log tail limits instead of parsing prefixes", () => {
    expect(() =>
      readTelegramUserProofLogTailBytes({
        OPENCLAW_TELEGRAM_USER_PROOF_LOG_TAIL_BYTES: "1e3",
      }),
    ).toThrow("invalid OPENCLAW_TELEGRAM_USER_PROOF_LOG_TAIL_BYTES: 1e3");
    expect(() =>
      readTelegramUserProofLogTailBytes({
        OPENCLAW_TELEGRAM_USER_PROOF_LOG_TAIL_BYTES: "1000bytes",
      }),
    ).toThrow("invalid OPENCLAW_TELEGRAM_USER_PROOF_LOG_TAIL_BYTES: 1000bytes");
    expect(
      readTelegramUserProofLogTailBytes({
        OPENCLAW_TELEGRAM_USER_PROOF_LOG_TAIL_BYTES: "4096",
      }),
    ).toBe(4096);
  });

  it.each([
    ["loose gateway", "--gateway-port", "1e3", "--gateway-port must be a positive integer."],
    [
      "out-of-range gateway",
      "--gateway-port",
      "65536",
      "--gateway-port must be a TCP port from 1 to 65535.",
    ],
    [
      "out-of-range mock",
      "--mock-port",
      "65536",
      "--mock-port must be a TCP port from 1 to 65535.",
    ],
  ])("rejects %s proof ports before remote setup", (_label, flag, value, message) => {
    expect(() => parseArgs([flag, value, "--dry-run"])).toThrow(message);
  });

  it("rejects short flags as proof option values before dry-run planning", () => {
    const result = runProofCli(["--output-dir", "-h", "--dry-run"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
    expect(result.stdout).toBe("");
  });

  it("keeps hyphen-prefixed free-text proof values", () => {
    expect(parseArgs(["--text", "-ping"]).text).toBe("-ping");
  });

  it("requires held sessions for identity inspection and lifecycle restart", () => {
    expect(() => parseArgs(["inspect"])).toThrow("inspect requires --session");
    expect(() => parseArgs(["restart"])).toThrow("restart requires --session");
    expect(parseArgs(["inspect", "--session", "session.json"]).command).toBe("inspect");
    expect(parseArgs(["restart", "--session", "session.json"]).command).toBe("restart");
    expect(
      parseArgs(["send", "--session", "session.json", "--chat", "@sut", "--text", "hello"]).chat,
    ).toBe("@sut");
    expect(() => parseArgs(["inspect", "--session", "session.json", "--chat", "@sut"])).toThrow(
      "--chat is available only for held-session sends",
    );
  });

  it("selects the documented Convex credential role for held proof", () => {
    expect(resolveTelegramUserProofCredentialRole(undefined, {})).toBe("maintainer");
    expect(resolveTelegramUserProofCredentialRole(undefined, { CI: "true" })).toBe("ci");
    expect(resolveTelegramUserProofCredentialRole("maintainer", { CI: "1" })).toBe("maintainer");
    expect(parseArgs(["start", "--credential-role", "ci"]).credentialRole).toBe("ci");
    expect(() => parseArgs(["start", "--credential-role", "operator"])).toThrow(
      'Credential role must be one of maintainer or ci, got "operator".',
    );
  });

  it("accepts an explicit Telegram link-preview setting", () => {
    expect(parseArgs(["start", "--link-preview", "false"]).linkPreview).toBe(false);
    expect(parseArgs(["start", "--link-preview", "true"]).linkPreview).toBe(true);
    expect(parseArgs(["start"]).linkPreview).toBeUndefined();
    expect(() => parseArgs(["start", "--link-preview", "disabled"])).toThrow(
      "--link-preview must be true or false.",
    );
  });

  it("accepts a positive mock response chunk delay", () => {
    expect(
      parseArgs(["start", "--mock-response-chunk-delay-ms", "1200"]).mockResponseChunkDelayMs,
    ).toBe(1200);
    expect(() => parseArgs(["start", "--mock-response-chunk-delay-ms", "0"])).toThrow(
      "--mock-response-chunk-delay-ms must be a positive integer.",
    );
  });

  it("accepts only a positive fixed human delay", () => {
    expect(parseArgs(["start", "--human-delay-fixed-ms", "1200"]).humanDelayFixedMs).toBe(1200);
    expect(() => parseArgs(["start", "--human-delay-fixed-ms", "0"])).toThrow(
      "--human-delay-fixed-ms must be a positive integer.",
    );
    expect(() => parseArgs(["start", "--human-delay-fixed-ms", "1e3"])).toThrow(
      "--human-delay-fixed-ms must be a positive integer.",
    );
    expect(() =>
      parseArgs(["send", "--session", "session.json", "--human-delay-fixed-ms", "1200"]),
    ).toThrow("--human-delay-fixed-ms is available only for start sessions.");
  });

  it("rejects duplicate single-value proof controls while keeping repeated expectations", () => {
    expect(() =>
      parseArgs(["--output-dir", ".artifacts/one", "--output-dir", ".artifacts/two"]),
    ).toThrow("--output-dir was provided more than once");

    expect(parseArgs(["--expect", "OpenClaw", "--expect", "ready"]).expect).toEqual([
      "OpenClaw",
      "ready",
    ]);
  });

  it("uses unique default output dirs", () => {
    const firstOutputDir = parseArgs([]).outputDir;
    const secondOutputDir = parseArgs([]).outputDir;

    expect(path.dirname(firstOutputDir)).toBe(
      path.join(".artifacts", "qa-e2e", "telegram-user-crabbox"),
    );
    expect(path.basename(firstOutputDir)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/u,
    );
    expect(secondOutputDir).not.toBe(firstOutputDir);
    expect(parseArgs(["--output-dir", ".artifacts/custom"]).outputDir).toBe(".artifacts/custom");
  });

  it("clamps proof timeout args before they reach Node timers", () => {
    expect(parseArgs(["--timeout-ms", String(MAX_TIMER_TIMEOUT_MS + 1)]).timeoutMs).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("enables the pinned MCP App fixture only when explicitly requested", () => {
    expect(parseArgs(["start", "--mcp-app-fixture"]).mcpAppFixture).toBe(true);
    expect(parseArgs([]).mcpAppFixture).toBe(false);

    const ordinaryArgs = createCrabboxWarmupArgs(parseArgs([]));
    const fixtureArgs = createCrabboxWarmupArgs(parseArgs(["start", "--mcp-app-fixture"]));
    expect(ordinaryArgs).not.toContain("--tailscale");
    expect(fixtureArgs).toContain("--tailscale");
    expect(() => parseArgs(["--mcp-app-fixture"])).toThrow(
      "--mcp-app-fixture is available only for start sessions.",
    );
    expect(() =>
      parseArgs([
        "start",
        "--mcp-app-fixture",
        "--sut-lane",
        "baseline",
        "--sut-repo-root",
        "/prepared/baseline",
      ]),
    ).toThrow("--mcp-app-fixture is unavailable for container-isolated SUT proof.");
    expect(() => parseArgs(["start", "--mcp-app-fixture", "--id", "cbx_reused"])).toThrow(
      "--mcp-app-fixture requires a fresh lifecycle-owned Crabbox lease.",
    );
  });

  it("writes an isolated Funnel and official MCP App fixture config", () => {
    const configRoot = writeSutConfig({
      gatewayPort: 19042,
      groupId: "group",
      mcpAppFixture: true,
      mockPort: 19043,
      outputDir: makeTempDir(tempDirs, "openclaw-telegram-proof-"),
      repoRoot: "/repo",
      testerId: "tester",
    });
    tempDirs.push(configRoot.tempRoot);
    const config = JSON.parse(fs.readFileSync(configRoot.configPath, "utf8"));

    expect(config.gateway).toMatchObject({
      auth: {
        mode: "password",
        password: { id: "OPENCLAW_GATEWAY_PASSWORD", source: "env" },
      },
      tailscale: { mode: "funnel" },
    });
    expect(config.mcp.servers.fixture).toEqual({
      args: ["/repo/scripts/e2e/mcp-app-conformance-server.mjs"],
      command: process.execPath,
    });
    expect(JSON.stringify(config)).not.toContain("companion-called");
    expect(JSON.stringify(config)).not.toContain("resource-ok");
  });

  it("enables execution identity before Telegram Gateway startup", () => {
    const configRoot = writeSutConfig({
      gatewayPort: 19042,
      groupId: "group",
      mockPort: 19043,
      outputDir: makeTempDir(tempDirs, "openclaw-telegram-proof-"),
      testerId: "tester",
    });
    tempDirs.push(configRoot.tempRoot);

    const config = JSON.parse(fs.readFileSync(configRoot.configPath, "utf8"));
    expect(config.logging.audit).toMatchObject({
      enabled: true,
      executionIdentity: true,
      messages: "direct",
    });
  });

  it("injects the requested Telegram link-preview setting before startup", () => {
    const disabledConfigRoot = writeSutConfig({
      gatewayPort: 19042,
      groupId: "group",
      linkPreview: false,
      mockPort: 19043,
      outputDir: makeTempDir(tempDirs, "openclaw-telegram-proof-"),
      testerId: "tester",
    });
    const defaultConfigRoot = writeSutConfig({
      gatewayPort: 19044,
      groupId: "group",
      mockPort: 19045,
      outputDir: makeTempDir(tempDirs, "openclaw-telegram-proof-"),
      testerId: "tester",
    });
    tempDirs.push(disabledConfigRoot.tempRoot, defaultConfigRoot.tempRoot);

    const disabledConfig = JSON.parse(fs.readFileSync(disabledConfigRoot.configPath, "utf8"));
    const defaultConfig = JSON.parse(fs.readFileSync(defaultConfigRoot.configPath, "utf8"));

    expect(disabledConfig.channels.telegram.linkPreview).toBe(false);
    expect(defaultConfig.channels.telegram).not.toHaveProperty("linkPreview");
  });

  it("injects the requested fixed human delay before startup", () => {
    const delayedConfigRoot = writeSutConfig({
      gatewayPort: 19042,
      groupId: "group",
      humanDelayFixedMs: 1200,
      mockPort: 19043,
      outputDir: makeTempDir(tempDirs, "openclaw-telegram-proof-"),
      testerId: "tester",
    });
    const defaultConfigRoot = writeSutConfig({
      gatewayPort: 19044,
      groupId: "group",
      mockPort: 19045,
      outputDir: makeTempDir(tempDirs, "openclaw-telegram-proof-"),
      testerId: "tester",
    });
    tempDirs.push(delayedConfigRoot.tempRoot, defaultConfigRoot.tempRoot);

    const delayedConfig = JSON.parse(fs.readFileSync(delayedConfigRoot.configPath, "utf8"));
    const defaultConfig = JSON.parse(fs.readFileSync(defaultConfigRoot.configPath, "utf8"));

    expect(delayedConfig.agents.defaults.humanDelay).toEqual({
      maxMs: 1200,
      minMs: 1200,
      mode: "custom",
    });
    expect(defaultConfig.agents.defaults).not.toHaveProperty("humanDelay");
  });

  it("pins the browser fixture SDK and exposes only the required app capabilities", () => {
    const fixture = fs.readFileSync("scripts/e2e/mcp-app-conformance-server.mjs", "utf8");
    const uiPackage = JSON.parse(fs.readFileSync("ui/package.json", "utf8"));

    expect(uiPackage.dependencies["@modelcontextprotocol/ext-apps"]).toBe("1.7.5");
    expect(fixture).toContain(
      `@modelcontextprotocol/ext-apps@${uiPackage.dependencies["@modelcontextprotocol/ext-apps"]}`,
    );
    expect(fixture).toContain('server.tool("app_companion"');
    expect(fixture).toContain('visibility: ["app"]');
    expect(fixture).toContain('"data://conformance/value"');
    expect(fixture).toContain('text: "resource-ok"');
  });

  it("serves the fixture view, app-only tool, and resource over official MCP stdio", async () => {
    const transport = new StdioClientTransport({
      args: ["scripts/e2e/mcp-app-conformance-server.mjs"],
      command: process.execPath,
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "telegram-proof-fixture-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.find((tool) => tool.name === "show")?._meta).toMatchObject({
        ui: { resourceUri: "ui://conformance/app" },
      });
      expect(tools.tools.find((tool) => tool.name === "app_companion")?._meta).toMatchObject({
        ui: { visibility: ["app"] },
      });
      expect(await client.callTool({ arguments: {}, name: "app_companion" })).toMatchObject({
        structuredContent: { value: "companion-called" },
      });
      expect(await client.readResource({ uri: "data://conformance/value" })).toMatchObject({
        contents: [{ text: "resource-ok" }],
      });
    } finally {
      await Promise.allSettled([client.close(), transport.close()]);
    }
  });

  posixIt("limits the Funnel bridge proxy to the Gateway lifecycle commands", () => {
    const root = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    const sshPath = path.join(root, "ssh");
    const argvPath = path.join(root, "ssh-argv.json");
    const proxyPath = path.join(root, "tailscale");
    writeExecutable(
      sshPath,
      `#!/usr/bin/env node\nimport fs from "node:fs";\nfs.writeFileSync(process.env.ARGV_PATH, JSON.stringify(process.argv.slice(2)));\n`,
    );
    writeExecutable(
      proxyPath,
      renderTailscaleSshProxy({
        gatewayPort: 19042,
        inspect: {
          host: "proof.example",
          sshHost: "",
          sshKey: "/tmp/proof-key",
          sshPort: "2222",
          sshUser: "proof",
        },
      }),
    );
    const env = {
      ...process.env,
      ARGV_PATH: argvPath,
      PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
    };

    const allowed = spawnSync(proxyPath, ["funnel", "--bg", "--yes", "19042"], {
      encoding: "utf8",
      env,
    });
    expect(allowed.status).toBe(0);
    const fallbackArgv = JSON.parse(fs.readFileSync(argvPath, "utf8"));
    expect(fallbackArgv).toContain("proof@proof.example");
    expect(fallbackArgv).toContain("'tailscale' 'funnel' '--bg' '--yes' '19042'");

    const rejected = spawnSync(proxyPath, ["serve", "--bg", "19042"], {
      encoding: "utf8",
      env,
    });
    expect(rejected.status).toBe(64);
    expect(rejected.stderr).toContain("unsupported proof Tailscale command");
  });

  posixIt("keeps the inspect SSH host when selecting a fallback port", async () => {
    const root = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    const sshPath = path.join(root, "ssh");
    const argvPath = path.join(root, "ssh-argv.json");
    const proxyPath = path.join(root, "tailscale");
    const inspect = {
      host: "public.example",
      sshFallbackPorts: ["22"],
      sshHost: "ssh.example",
      sshKey: "/tmp/proof-key",
      sshPort: "2222",
      sshUser: "proof",
    };
    const probes: string[] = [];
    const sshPort = await selectCrabboxSshPort({
      inspect,
      probe: async (port) => {
        probes.push(port);
        if (port === "2222") {
          throw new Error("Connection refused");
        }
      },
    });
    writeExecutable(
      sshPath,
      `#!/usr/bin/env node\nimport fs from "node:fs";\nfs.writeFileSync(process.env.ARGV_PATH, JSON.stringify(process.argv.slice(2)));\n`,
    );
    writeExecutable(
      proxyPath,
      renderTailscaleSshProxy({
        gatewayPort: 19042,
        inspect: { ...inspect, sshPort },
      }),
    );

    const result = spawnSync(proxyPath, ["status", "--json"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ARGV_PATH: argvPath,
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    const argv = JSON.parse(fs.readFileSync(argvPath, "utf8"));
    expect(probes).toEqual(["2222", "22"]);
    expect(argv).toContain("proof@ssh.example");
    expect(argv).not.toContain("proof@public.example");
    const portFlagIndex = argv.indexOf("-p");
    expect(argv.slice(portFlagIndex, portFlagIndex + 2)).toEqual(["-p", "22"]);
  });

  it("reads only the requested log tail", () => {
    const logPath = path.join(makeTempDir(tempDirs, "openclaw-telegram-proof-"), "gateway.log");
    fs.writeFileSync(logPath, `${"old\n".repeat(2000)}ready\n`, "utf8");

    const tail = readLogTail(logPath, 32);

    expect(tail).toContain("ready");
    expect(tail.length).toBeLessThanOrEqual(32);
    expect(tail).not.toContain("old\nold\nold\nold\nold\nold\nold\nold\nold");
  });

  it("observes restart readiness only after the lifecycle log boundary", async () => {
    const logPath = path.join(makeTempDir(tempDirs, "openclaw-telegram-proof-"), "gateway.log");
    fs.writeFileSync(logPath, "[gateway] ready\n", "utf8");
    const offset = fs.statSync(logPath).size;
    expect(readLogAfterOffset(logPath, offset)).toBe("");

    fs.appendFileSync(logPath, "received SIGUSR1; restarting\ngateway ready\n", "utf8");

    await expect(
      waitForLogAfterOffset({
        label: "restart",
        logPath,
        offset,
        pattern: /received SIGUSR1; restarting/u,
        timeoutMs: 100,
      }),
    ).resolves.toContain("gateway ready");
  });

  posixIt("requests held Gateway restart through its pinned canonical CLI", async () => {
    const root = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    const gatewayLog = path.join(root, "gateway.log");
    const argvPath = path.join(root, "restart-argv.json");
    const fakePnpm = path.join(root, "pnpm.cjs");
    const sessionPath = path.join(root, "session.json");
    fs.writeFileSync(gatewayLog, "gateway ready\n");
    writeExecutable(
      fakePnpm,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
fs.appendFileSync(${JSON.stringify(gatewayLog)}, "received SIGUSR1; restarting\\ngateway ready\\n");
process.stdout.write(JSON.stringify({ ok: true, status: "scheduled" }));
`,
    );
    fs.writeFileSync(
      sessionPath,
      JSON.stringify({
        command: "telegram-user-crabbox-session",
        localSut: {
          configPath: path.join(root, "openclaw.json"),
          gatewayLog,
          gatewayPid: 123,
          gatewayPort: 19042,
          stateDir: path.join(root, "state"),
          tempRoot: root,
        },
      }),
    );
    vi.stubEnv("MANTIS_PNPM_BIN", fakePnpm);
    const opts = parseArgs(["restart", "--session", sessionPath, "--timeout-ms", "1000"]);

    await expect(restartSessionGateway(root, opts, root)).resolves.toMatchObject({
      gatewayPort: 19042,
      status: "pass",
    });

    expect(JSON.parse(fs.readFileSync(argvPath, "utf8"))).toEqual([
      "openclaw",
      "gateway",
      "call",
      "gateway.restart.request",
      "--port",
      "19042",
      "--params",
      '{"reason":"telegram-user-crabbox-proof"}',
      "--json",
    ]);
  });

  posixIt("signals a detached Gateway through its launcher process group", async () => {
    const root = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    const gatewayPath = path.join(root, "gateway.mjs");
    const launcherPath = path.join(root, "launcher.mjs");
    const logPath = path.join(root, "gateway.log");
    const readyPath = path.join(root, "gateway.ready");
    writeExecutable(
      gatewayPath,
      `import fs from "node:fs";
const [logPath, readyPath] = process.argv.slice(2);
process.on("SIGUSR1", () => fs.appendFileSync(logPath, "received SIGUSR1; restarting\\ngateway ready\\n"));
fs.writeFileSync(readyPath, String(process.pid));
setInterval(() => {}, 1000);
`,
    );
    writeExecutable(
      launcherPath,
      `import { spawn } from "node:child_process";
const [gatewayPath, logPath, readyPath] = process.argv.slice(2);
spawn(process.execPath, [gatewayPath, logPath, readyPath], { stdio: "ignore" });
process.on("SIGUSR1", () => {});
setInterval(() => {}, 1000);
`,
    );
    const launcher = spawn(process.execPath, [launcherPath, gatewayPath, logPath, readyPath], {
      detached: true,
      stdio: "ignore",
    });
    try {
      await waitFor(() => fs.existsSync(readyPath));

      signalPidTree(launcher.pid, "SIGUSR1");

      await waitFor(
        () =>
          fs.existsSync(logPath) &&
          fs.readFileSync(logPath, "utf8").includes("received SIGUSR1; restarting"),
      );
    } finally {
      if (launcher.pid) {
        try {
          process.kill(-launcher.pid, "SIGKILL");
        } catch {}
      }
    }
  });

  it("keeps byte-cut log tails UTF-8 safe and reads at least one byte", () => {
    const logPath = path.join(makeTempDir(tempDirs, "openclaw-telegram-proof-"), "gateway.log");
    fs.writeFileSync(
      logPath,
      Buffer.concat([Buffer.from("x".repeat(100)), Buffer.from("😀"), Buffer.from("y".repeat(20))]),
    );

    expect(readLogTail(logPath, 23)).toBe("y".repeat(20));
    expect(readLogTail(logPath, 24)).toBe(`😀${"y".repeat(20)}`);
    expect(readLogTail(logPath, 0)).toBe("y");
  });

  it("keeps readiness timeout tails free of split surrogate pairs", async () => {
    const logPath = path.join(makeTempDir(tempDirs, "openclaw-telegram-proof-"), "gateway.log");
    fs.writeFileSync(logPath, `${"a".repeat(9)}😀${"b".repeat(3999)}`, "utf8");

    let message = "";
    try {
      await waitForLog(logPath, /\[gateway\] ready/u, "gateway", 0);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    const tail = message.split("\n").at(-1) ?? "";
    expect(tail).toBe("b".repeat(3999));
    expect(hasLoneSurrogate(tail)).toBe(false);
  });

  it("honors short reads when a log shrinks during tailing", () => {
    vi.spyOn(fs, "statSync").mockReturnValue({
      isFile: () => true,
      size: 64,
    } as fs.Stats);
    vi.spyOn(fs, "openSync").mockReturnValue(123 as never);
    vi.spyOn(fs, "closeSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readSync").mockImplementation((_fd, buffer) => {
      if (!Buffer.isBuffer(buffer)) {
        throw new Error("expected buffer read");
      }
      buffer.write("ready");
      return 5;
    });

    expect(readLogTail("/tmp/truncated.log", 64)).toBe("ready");
  });

  it("does not reread the full log while waiting for readiness", async () => {
    const logPath = path.join(makeTempDir(tempDirs, "openclaw-telegram-proof-"), "mock-openai.log");
    fs.writeFileSync(logPath, `${"noise\n".repeat(2000)}mock-openai listening\n`, "utf8");
    const readFileSync = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("full log read");
    });

    await waitForLog(logPath, /mock-openai listening/u, "mock-openai", 100);

    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("reports only a bounded log tail on timeout", async () => {
    const logPath = path.join(makeTempDir(tempDirs, "openclaw-telegram-proof-"), "gateway.log");
    fs.writeFileSync(logPath, `old-secret\n${"x".repeat(300_000)}recent failure\n`, "utf8");

    let message = "";
    try {
      await waitForLog(logPath, /\[gateway\] ready/u, "gateway", 0);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("recent failure");
    expect(message).not.toContain("old-secret");
  });

  it("bounds remote Telegram Desktop launch diagnostics", () => {
    const script = renderLaunchDesktop();

    expect(script).toContain("print_desktop_log_tail() {");
    expect(script).toContain('tail -c 262144 "$log_file"');
    expect(script).toContain("print_desktop_log_tail\n  exit 1");
    expect(script).not.toContain('cat "$root/telegram-desktop.log"');
  });

  it("shell-quotes generated remote setup and chat literals", () => {
    const payload = "name $(touch /tmp/openclaw-proof-injected) `touch /tmp/also-injected`";

    expect(renderRemoteSetup({ tdlibSha256: payload, tdlibUrl: payload })).toContain(
      `tdlib_url='${payload}'`,
    );
    expect(renderSelectDesktopChat({ chatTitle: payload })).toContain(`chat_title='${payload}'`);
  });

  it("stages full publish artifacts without session control files", () => {
    const outputDir = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    const publishDir = path.join(outputDir, "publish-full-artifacts");
    fs.mkdirSync(publishDir);
    fs.writeFileSync(path.join(publishDir, "stale.txt"), "stale");
    fs.mkdirSync(path.join(outputDir, "publish-gif-only"));
    fs.writeFileSync(
      path.join(outputDir, "session.json"),
      '{"sshKey":"/private/tmp/openclaw/key"}',
    );
    fs.writeFileSync(path.join(outputDir, "lease.json"), '{"token":"secret"}');
    fs.writeFileSync(path.join(outputDir, "status.json"), '{"ok":true}');
    fs.writeFileSync(path.join(outputDir, "probe.json"), '{"ok":true}');
    fs.writeFileSync(path.join(outputDir, "probe-2026-06-20T16-47-48-123Z.json"), '{"ok":true}');
    fs.writeFileSync(path.join(outputDir, "probe-secret.json"), '{"token":"secret"}');
    fs.writeFileSync(path.join(outputDir, "telegram-user-crabbox-session-summary.json"), "{}");
    fs.writeFileSync(path.join(outputDir, "telegram-user-crabbox-proof.md"), "report");
    fs.writeFileSync(path.join(outputDir, "telegram-desktop.log"), "log");
    fs.writeFileSync(path.join(outputDir, "telegram-user-crabbox-session-motion.gif"), "gif");
    fs.writeFileSync(path.join(outputDir, "telegram-user-crabbox-session.mp4"), "video");

    const stagedDir = stageFullSessionArtifacts(outputDir);

    expect(stagedDir).toBe(publishDir);
    expect(fs.readdirSync(stagedDir).toSorted()).toEqual([
      "probe-2026-06-20T16-47-48-123Z.json",
      "probe.json",
      "status.json",
      "telegram-desktop.log",
      "telegram-user-crabbox-proof.md",
      "telegram-user-crabbox-session-motion.gif",
      "telegram-user-crabbox-session-summary.json",
      "telegram-user-crabbox-session.mp4",
    ]);
    expect(fs.existsSync(path.join(stagedDir, "session.json"))).toBe(false);
    expect(fs.existsSync(path.join(stagedDir, "lease.json"))).toBe(false);
    expect(fs.existsSync(path.join(stagedDir, "probe-secret.json"))).toBe(false);
    expect(fs.existsSync(path.join(stagedDir, "stale.txt"))).toBe(false);
  });

  it("requires finish to write the proof report before full artifact publishing", () => {
    const outputDir = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    fs.writeFileSync(
      path.join(outputDir, "session.json"),
      '{"sshKey":"/private/tmp/openclaw/key"}',
    );
    fs.writeFileSync(path.join(outputDir, "status.json"), '{"ok":true}');
    fs.writeFileSync(path.join(outputDir, "telegram-desktop.log"), "log");

    expect(() => stageFullSessionArtifacts(outputDir)).toThrow(
      "Missing proof report. Run finish first: telegram-user-crabbox-proof.md",
    );
    expect(fs.existsSync(path.join(outputDir, "publish-full-artifacts"))).toBe(false);
  });

  posixIt("does not expand generated remote probe arguments in the shell", () => {
    const root = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    const fakePython = path.join(root, "python3");
    const scriptPath = path.join(root, "remote-probe.sh");
    const argvPath = path.join(root, "argv.json");
    const injectedPath = path.join(root, "injected");
    const payload = `literal ' $(touch ${injectedPath})`;
    writeExecutable(
      fakePython,
      `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(process.env.OPENCLAW_TEST_ARGV_PATH, JSON.stringify(process.argv.slice(1)));
`,
    );
    writeExecutable(
      scriptPath,
      renderRemoteProbe({
        chat: "@proof-bot",
        expect: [payload],
        sutUsername: payload,
        text: payload,
        timeoutMs: 1000,
      }),
    );

    const result = spawnSync("bash", [scriptPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_TEST_ARGV_PATH: argvPath,
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(injectedPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(argvPath, "utf8"))).toContain(payload);
    expect(JSON.parse(fs.readFileSync(argvPath, "utf8"))).toContain("@proof-bot");
  });

  it("clamps oversized command timeouts before arming timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await expect(
      runCommand({
        args: ["--version"],
        command: process.execPath,
        cwd: process.cwd(),
        timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
      }),
    ).resolves.toMatchObject({ stderr: "" });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    setTimeoutSpy.mockRestore();
  });

  it("keeps command failure tails free of split surrogate pairs", async () => {
    const root = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    const scriptPath = path.join(root, "unicode-failure.mjs");
    fs.writeFileSync(
      scriptPath,
      `
await new Promise((resolve) => {
  process.stdout.write("a".repeat(3) + "😀" + "b".repeat(65_535), resolve);
});
await new Promise((resolve) => {
  process.stderr.write("😀" + "c".repeat(262_143), resolve);
});
process.exitCode = 2;
`,
    );
    let message = "";
    try {
      await runCommand({
        args: [scriptPath],
        command: process.execPath,
        cwd: root,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    const marker = "[stdout truncated to last 65536 characters]\n";
    const tail = message.split(marker).at(-1) ?? "";
    expect(message).toContain(marker);
    expect(tail.startsWith("b".repeat(100))).toBe(true);
    expect(tail.endsWith("c".repeat(100))).toBe(true);
    expect(tail).not.toContain("😀");
    expect(hasLoneSurrogate(tail)).toBe(false);
  });

  it("decodes command output statefully across split stream chunks", async () => {
    const script = [
      'const emoji = Buffer.from("😀", "utf8");',
      "process.stdout.write(emoji.subarray(0, 2));",
      "process.stderr.write(emoji.subarray(0, 2));",
      "setTimeout(() => {",
      "  process.stdout.write(emoji.subarray(2));",
      "  process.stderr.write(emoji.subarray(2));",
      "  process.exit(2);",
      "}, 100);",
    ].join("\n");
    let message = "";
    try {
      await runCommand({
        args: ["-e", script],
        command: process.execPath,
        cwd: makeTempDir(tempDirs, "openclaw-telegram-proof-"),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    const output = message.split("failed with exit code 2\n").at(-1) ?? "";
    expect(output.match(/😀/gu)).toHaveLength(2);
    expect(output).not.toContain("�");
  });

  posixIt("kills timed-out command process groups when the leader exits first", async () => {
    const root = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    const scriptPath = path.join(root, "trap-term.mjs");
    const grandchildPidPath = path.join(root, "grandchild.pid");
    let grandchildPid = 0;

    fs.writeFileSync(
      scriptPath,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";

const grandchild = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
], { stdio: "ignore" });
fs.writeFileSync(process.argv[2], String(grandchild.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const runPromise = runCommand({
      args: [scriptPath, grandchildPidPath],
      command: process.execPath,
      cwd: root,
      timeoutKillGraceMs: 100,
      timeoutMs: 500,
    });
    const runResult = runPromise.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ error, ok: false as const }),
    );

    try {
      await waitFor(() => {
        if (!fs.existsSync(grandchildPidPath)) {
          return false;
        }
        grandchildPid = Number.parseInt(fs.readFileSync(grandchildPidPath, "utf8"), 10);
        return Number.isInteger(grandchildPid) && isProcessAlive(grandchildPid);
      });
      expect(Number.isInteger(grandchildPid)).toBe(true);

      const result = await runResult;
      expect(result).toMatchObject({
        error: {
          code: "ETIMEDOUT",
          message: expect.stringContaining("timed out after 500ms"),
        },
        ok: false,
      });
      await waitFor(() => !isProcessAlive(grandchildPid));
    } finally {
      await runResult.catch(() => {});
      if (grandchildPid && isProcessAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
    }
  });

  posixIt("lets timed-out command descendants exit during kill grace", async () => {
    const root = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    const scriptPath = path.join(root, "trap-term-grace.mjs");
    const readyPath = path.join(root, "descendant.ready");
    const donePath = path.join(root, "descendant.done");

    fs.writeFileSync(
      scriptPath,
      `
import { spawn } from "node:child_process";

const descendant = spawn(process.execPath, [
  "--input-type=module",
  "--eval",
  ${JSON.stringify(
    `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  setTimeout(() => {
    writeFileSync(${JSON.stringify(donePath)}, "done");
    process.exit(0);
  }, 75);
});
writeFileSync(${JSON.stringify(readyPath)}, "ready");
setInterval(() => {}, 1000);`,
  )},
], { stdio: "ignore" });
descendant.unref();
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const runPromise = runCommand({
      args: [scriptPath],
      command: process.execPath,
      cwd: root,
      timeoutKillGraceMs: 500,
      timeoutMs: 500,
    });

    await waitFor(() => fs.existsSync(readyPath));
    await expect(runPromise).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: expect.stringContaining("timed out after 500ms"),
    });
    expect(fs.readFileSync(donePath, "utf8")).toBe("done");
  });

  posixIt("keeps closed command groups tracked for parent cleanup", async () => {
    const root = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    const commandPath = path.join(root, "closed-command.mjs");
    const runnerPath = path.join(root, "closed-command-runner.mjs");
    const commandSettledPath = path.join(root, "command-settled");
    const descendantPidPath = path.join(root, "closed-command-descendant.pid");
    const descendantTermPath = path.join(root, "closed-command-descendant.term");
    let descendantPid = 0;

    fs.writeFileSync(
      commandPath,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";

const descendant = spawn(process.execPath, [
  "-e",
  ${JSON.stringify(
    `const fs = require("node:fs");
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(descendantTermPath)}, "terminated");
  process.exit(0);
});
fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));
setInterval(() => {}, 1000);`,
  )},
], { stdio: "ignore" });
descendant.unref();
`,
      "utf8",
    );
    fs.writeFileSync(
      runnerPath,
      `
import fs from "node:fs";

const proof = await import(${JSON.stringify(
        pathToFileURL(path.resolve("scripts/e2e/telegram-user-crabbox-proof.ts")).href,
      )});
await proof.runCommand({
  args: [${JSON.stringify(commandPath)}],
  command: process.execPath,
  cwd: ${JSON.stringify(root)},
  timeoutMs: 30_000,
});
fs.writeFileSync(${JSON.stringify(commandSettledPath)}, "1");
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const runner = spawn(process.execPath, ["--import", "tsx", runnerPath], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    try {
      await waitFor(() => {
        if (!fs.existsSync(descendantPidPath)) {
          return false;
        }
        descendantPid = Number.parseInt(fs.readFileSync(descendantPidPath, "utf8"), 10);
        return (
          Number.isInteger(descendantPid) && descendantPid > 1 && isProcessAlive(descendantPid)
        );
      });
      expect(Number.isInteger(descendantPid)).toBe(true);
      await waitFor(() => fs.existsSync(commandSettledPath));
      if (!runner.pid) {
        throw new Error("runner did not start");
      }

      process.kill(runner.pid, "SIGTERM");

      await waitFor(() => fs.existsSync(descendantTermPath));
      await waitFor(() => !isProcessAlive(descendantPid));
    } finally {
      if (runner.pid && isProcessAlive(runner.pid)) {
        process.kill(runner.pid, "SIGKILL");
      }
      if (descendantPid && isProcessAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  });

  posixIt("keeps local SUT startup tails Unicode-safe and cleans child processes", async () => {
    const root = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    const outputDir = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    const mockScript = path.join(root, "scripts/e2e/mock-openai-server.mjs");
    const gatewayScript = path.join(root, "gateway-fail.mjs");
    const mockPidPath = path.join(root, "mock.pid");
    const mockTermPath = path.join(root, "mock.term");
    fs.mkdirSync(path.dirname(mockScript), { recursive: true });
    writeExecutable(
      mockScript,
      `
import fs from "node:fs";

// Handler before the readiness line: SIGTERM arrives once the gateway spawn
// fails, and a late-registered handler can lose it to the default disposition.
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(mockTermPath)}, "terminated");
  process.exit(0);
});
fs.writeFileSync(${JSON.stringify(mockPidPath)}, String(process.pid));
process.stdout.write("mock-openai listening\\n");
setInterval(() => {}, 1000);
`,
    );
    writeExecutable(
      gatewayScript,
      `
const output = "😀" + "x".repeat(7998) + "😀" + "y".repeat(3999);
process.stderr.write(output);
process.exit(2);
`,
    );

    let message = "";
    try {
      await startLocalSut(
        {
          gatewayPort: 19042,
          groupId: "group",
          mockPort: 19043,
          mockResponseText: "ok",
          outputDir,
          repoRoot: root,
          sutToken: "token",
          testerId: "tester",
        },
        {
          createGatewaySpawnSpec: () => ({
            args: [gatewayScript],
            command: process.execPath,
            options: { cwd: root, env: process.env },
          }),
          drainUpdates: async () => ({
            drained: 0,
            pendingAfter: undefined,
            pendingBefore: undefined,
            webhookUrlSet: false,
          }),
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("gateway exited before ready");
    expect(message.endsWith("y".repeat(3999))).toBe(true);
    expect(hasLoneSurrogate(message)).toBe(false);
    await waitFor(() => fs.existsSync(mockTermPath));
    const mockPid = Number.parseInt(fs.readFileSync(mockPidPath, "utf8"), 10);
    await waitFor(() => !isProcessAlive(mockPid));
  });

  posixIt("cleans gateway descendants after a failed gateway leader exits", async () => {
    const root = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    const outputDir = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    const mockScript = path.join(root, "scripts/e2e/mock-openai-server.mjs");
    const gatewayScript = path.join(root, "gateway-leader-exits.mjs");
    const gatewayGrandchildPidPath = path.join(root, "gateway-grandchild.pid");
    let gatewayGrandchildPid = 0;
    fs.mkdirSync(path.dirname(mockScript), { recursive: true });
    writeExecutable(
      mockScript,
      `
process.stdout.write("mock-openai listening\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
    );
    writeExecutable(
      gatewayScript,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";

const grandchild = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);",
], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(gatewayGrandchildPidPath)}, String(grandchild.pid));
process.exit(2);
`,
    );

    try {
      await expect(
        startLocalSut(
          {
            gatewayPort: 19042,
            groupId: "group",
            mockPort: 19043,
            mockResponseText: "ok",
            outputDir,
            repoRoot: root,
            sutToken: "token",
            testerId: "tester",
          },
          {
            createGatewaySpawnSpec: () => ({
              args: [gatewayScript],
              command: process.execPath,
              options: { cwd: root, env: process.env },
            }),
            drainUpdates: async () => ({
              drained: 0,
              pendingAfter: undefined,
              pendingBefore: undefined,
              webhookUrlSet: false,
            }),
            waitForOutputReady: async (child, _pattern, output, label) => {
              if (label === "mock-openai") {
                await waitFor(() => output().includes("mock-openai listening"));
                return;
              }
              // Parse inside the poll: existsSync can observe writeFileSync's
              // 0-byte open-truncate window, and a NaN pid would skip both the
              // dead-check and the finally-block SIGKILL cleanup.
              await waitFor(() => {
                if (!fs.existsSync(gatewayGrandchildPidPath)) {
                  return false;
                }
                gatewayGrandchildPid = Number.parseInt(
                  fs.readFileSync(gatewayGrandchildPidPath, "utf8"),
                  10,
                );
                return Number.isInteger(gatewayGrandchildPid) && gatewayGrandchildPid > 1;
              });
              if (child.exitCode === null && child.signalCode === null) {
                await new Promise<void>((resolve) => {
                  child.once("exit", () => resolve());
                });
              }
              throw new Error("gateway exited before ready");
            },
          },
        ),
      ).rejects.toThrow("gateway exited before ready");

      await waitFor(() => !isProcessAlive(gatewayGrandchildPid));
    } finally {
      if (gatewayGrandchildPid && isProcessAlive(gatewayGrandchildPid)) {
        process.kill(gatewayGrandchildPid, "SIGKILL");
      }
    }
  });

  posixIt("stops Crabbox recording when the desktop probe fails", async () => {
    const root = makeTempDir(tempDirs, "openclaw-telegram-proof-");
    const recorderPath = path.join(root, "fake-crabbox-recorder.mjs");
    const recorderPidPath = path.join(root, "recorder.pid");
    const recorderTermPath = path.join(root, "recorder.term");
    writeExecutable(
      recorderPath,
      `#!/usr/bin/env node
import fs from "node:fs";

// Arm the SIGTERM handler before publishing the pid file: the probe throws as
// soon as the pid file exists and recordProbeVideo SIGTERMs the recorder in
// its finally, so a handler installed after publish can lose that signal to
// the default disposition and recorder.term is never written.
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(recorderTermPath)}, "terminated");
  process.exit(0);
});
fs.writeFileSync(${JSON.stringify(recorderPidPath)}, String(process.pid));
setInterval(() => {}, 1000);
`,
    );

    await expect(
      recordProbeVideo({
        crabboxBin: recorderPath,
        cwd: root,
        durationSeconds: 30,
        leaseId: "cbx_test",
        outputPath: path.join(root, "proof.mp4"),
        provider: "aws",
        runProbe: async () => {
          await waitFor(() => fs.existsSync(recorderPidPath));
          throw new Error("probe failed");
        },
        startDelayMs: 0,
        target: "linux",
      }),
    ).rejects.toThrow("probe failed");

    await waitFor(() => fs.existsSync(recorderTermPath));
    const recorderPid = Number.parseInt(fs.readFileSync(recorderPidPath, "utf8"), 10);
    await waitFor(() => !isProcessAlive(recorderPid));
  });

  posixIt(
    "does not wait forever when Crabbox recording exits before the probe returns",
    async () => {
      const root = makeTempDir(tempDirs, "openclaw-telegram-proof-");
      const recorderPath = path.join(root, "fake-crabbox-recorder.mjs");
      const recorderExitPath = path.join(root, "recorder.exit");
      writeExecutable(
        recorderPath,
        `#!/usr/bin/env node
import fs from "node:fs";

fs.writeFileSync(${JSON.stringify(recorderExitPath)}, "exited");
`,
      );

      await expect(
        Promise.race([
          recordProbeVideo({
            crabboxBin: recorderPath,
            cwd: root,
            durationSeconds: 1,
            leaseId: "cbx_test",
            outputPath: path.join(root, "proof.mp4"),
            provider: "aws",
            runProbe: async () => {
              await waitFor(() => fs.existsSync(recorderExitPath));
              await delay(50);
            },
            startDelayMs: 0,
            target: "linux",
          }),
          delay(500, undefined, { ref: false }).then(() => {
            throw new Error("recordProbeVideo hung after the recorder had already exited");
          }),
        ]),
      ).resolves.toBeUndefined();
    },
  );
});
