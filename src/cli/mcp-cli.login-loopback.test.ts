// MCP CLI login loopback tests cover the OAuth loopback callback flow.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import { registerMcpCli } from "./mcp-cli.js";

type CreateSessionMcpRuntime =
  typeof import("../agents/agent-bundle-mcp-runtime.js").createSessionMcpRuntime;

const mocks = vi.hoisted(() => {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      runtime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
  };
  return {
    runtime,
    serveOpenClawChannelMcp: vi.fn(),
    clearMcpOAuthCredentials: vi.fn(),
    readMcpOAuthCredentialsStatus: vi.fn(),
    resolveMcpOAuthEffectiveRedirectUrl: vi.fn(),
    runMcpOAuthLogin: vi.fn(),
    createSessionMcpRuntimeOverride: undefined as CreateSessionMcpRuntime | undefined,
  };
});

const mockLog = mocks.runtime.log;
const mockError = mocks.runtime.error;
const readMcpOAuthCredentialsStatus = mocks.readMcpOAuthCredentialsStatus;
const resolveMcpOAuthEffectiveRedirectUrl = mocks.resolveMcpOAuthEffectiveRedirectUrl;
const runMcpOAuthLogin = mocks.runMcpOAuthLogin;

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

vi.mock("../mcp/channel-server.js", () => ({
  serveOpenClawChannelMcp: mocks.serveOpenClawChannelMcp,
}));

vi.mock("../agents/mcp-oauth.js", () => ({
  clearMcpOAuthCredentials: mocks.clearMcpOAuthCredentials,
  readMcpOAuthCredentialsStatus: mocks.readMcpOAuthCredentialsStatus,
  resolveMcpOAuthEffectiveRedirectUrl: mocks.resolveMcpOAuthEffectiveRedirectUrl,
  runMcpOAuthLogin: mocks.runMcpOAuthLogin,
}));

vi.mock("../agents/agent-bundle-mcp-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/agent-bundle-mcp-runtime.js")>();
  return {
    ...actual,
    createSessionMcpRuntime: (params: Parameters<CreateSessionMcpRuntime>[0]) =>
      mocks.createSessionMcpRuntimeOverride?.(params) ?? actual.createSessionMcpRuntime(params),
  };
});

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-mcp-"));
  tempDirs.push(dir);
  return dir;
}

async function waitForLogContaining(text: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (mockLog.mock.calls.some((call) => String(call[0]).includes(text))) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`Timed out waiting for log containing: ${text}`);
}

async function findFreePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("No free port"))));
    });
  });
}

let sharedProgram: Command;

async function runMcpCommand(args: string[]) {
  await sharedProgram.parseAsync(args, { from: "user" });
}

describe("mcp cli login loopback", () => {
  if (!sharedProgram) {
    sharedProgram = new Command();
    sharedProgram.exitOverride();
    registerMcpCli(sharedProgram);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSessionMcpRuntimeOverride = undefined;
    readMcpOAuthCredentialsStatus.mockResolvedValue({
      hasTokens: false,
      requiresAuthorization: false,
      hasClientInformation: false,
      hasCodeVerifier: false,
      hasDiscoveryState: false,
      hasLastAuthorizationUrl: false,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("completes login through the loopback callback server", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      const port = await findFreePort();
      const redirectUrl = `http://127.0.0.1:${port}/oauth/callback`;
      resolveMcpOAuthEffectiveRedirectUrl.mockReturnValue(redirectUrl);
      runMcpOAuthLogin.mockImplementation(
        async (params: {
          authorizationCode?: string;
          onAuthorizationUrl?: (url: URL) => void | Promise<void>;
        }) => {
          if (params.authorizationCode) {
            return "authorized";
          }
          await params.onAuthorizationUrl?.(
            new URL("https://auth.example.com/authorize?state=state-123"),
          );
          return "redirect";
        },
      );

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","transport":"streamable-http","auth":"oauth"}',
      ]);
      mockLog.mockClear();

      const commandPromise = runMcpCommand(["mcp", "login", "docs"]);
      await waitForLogContaining("Waiting for the browser");
      const response = await fetch(`${redirectUrl}?code=code-456&state=state-123`);
      expect(response.ok).toBe(true);
      await commandPromise;

      expect(runMcpOAuthLogin).toHaveBeenCalledTimes(2);
      expect(runMcpOAuthLogin).toHaveBeenLastCalledWith(
        expect.objectContaining({ authorizationCode: "code-456" }),
      );
      expect(mockLog).toHaveBeenCalledWith('MCP OAuth credentials saved for "docs".');
    });
  });

  it("rejects a loopback callback whose state does not match the authorization URL", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      const port = await findFreePort();
      const redirectUrl = `http://127.0.0.1:${port}/oauth/callback`;
      resolveMcpOAuthEffectiveRedirectUrl.mockReturnValue(redirectUrl);
      runMcpOAuthLogin.mockImplementation(
        async (params: {
          authorizationCode?: string;
          onAuthorizationUrl?: (url: URL) => void | Promise<void>;
        }) => {
          if (params.authorizationCode) {
            return "authorized";
          }
          await params.onAuthorizationUrl?.(
            new URL("https://auth.example.com/authorize?state=state-123"),
          );
          return "redirect";
        },
      );

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","transport":"streamable-http","auth":"oauth"}',
      ]);
      mockLog.mockClear();

      const commandPromise = runMcpCommand(["mcp", "login", "docs"]);
      const commandOutcome = commandPromise.then(
        () => undefined,
        (error: unknown) => error,
      );
      await waitForLogContaining("Waiting for the browser");
      await fetch(`${redirectUrl}?code=code-456&state=state-mismatch`);
      const outcome = await commandOutcome;
      expect(outcome).toBeInstanceOf(Error);
      if (!(outcome instanceof Error)) {
        throw new Error("expected the login command to exit with an error");
      }
      expect(outcome.message).toContain("__exit__:1");

      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("state mismatch"));
      expect(runMcpOAuthLogin).toHaveBeenCalledTimes(1);
    });
  });

  it("falls back to the manual code flow when the loopback port is unavailable", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      const net = await import("node:net");
      const blocker = net.createServer();
      await new Promise<void>((resolve) => {
        blocker.listen(0, "127.0.0.1", resolve);
      });
      const address = blocker.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const redirectUrl = `http://127.0.0.1:${port}/oauth/callback`;
      resolveMcpOAuthEffectiveRedirectUrl.mockReturnValue(redirectUrl);
      runMcpOAuthLogin.mockResolvedValue("redirect");

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","transport":"streamable-http","auth":"oauth"}',
      ]);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "login", "docs"]);

      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining("falling back to manual code flow"),
      );
      expect(runMcpOAuthLogin).toHaveBeenCalledTimes(1);
      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      });
    });
  });
});
