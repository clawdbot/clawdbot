import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import { getFreePort } from "../test-utils/ports.js";
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
    writeJson: vi.fn(),
  };
  return {
    runtime,
    runMcpOAuthLogin: vi.fn(),
    readMcpOAuthCredentialsStatus: vi.fn(),
    createSessionMcpRuntimeOverride: undefined as CreateSessionMcpRuntime | undefined,
  };
});

vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.runtime }));
vi.mock("../mcp/channel-server.js", () => ({ serveOpenClawChannelMcp: vi.fn() }));
vi.mock("../agents/mcp-oauth.js", () => ({
  clearMcpOAuthCredentials: vi.fn(),
  readMcpOAuthCredentialsStatus: mocks.readMcpOAuthCredentialsStatus,
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
let program: Command;

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-mcp-loopback-"));
  tempDirs.push(dir);
  return dir;
}

async function waitForLog(text: string): Promise<void> {
  await vi.waitFor(() => {
    expect(mocks.runtime.log.mock.calls.some(([line]) => String(line).includes(text))).toBe(true);
  });
}

async function configureServer(): Promise<void> {
  vi.spyOn(process, "cwd").mockReturnValue(await createWorkspace());
  await program.parseAsync(
    [
      "mcp",
      "set",
      "docs",
      '{"url":"https://mcp.example.com","transport":"streamable-http","auth":"oauth"}',
    ],
    { from: "user" },
  );
  mocks.runtime.log.mockClear();
}

function mockRedirectFlow(redirectUrl: string): void {
  mocks.runMcpOAuthLogin.mockImplementation(
    async (params: {
      authorizationCode?: string;
      onAuthorizationUrl?: (url: URL) => void | Promise<void>;
      onAuthorizationSession?: (session: { codeVerifier: string; redirectUrl: string }) => void;
    }) => {
      if (params.authorizationCode) {
        return "authorized";
      }
      const authorizationUrl = new URL("https://auth.example.com/authorize");
      authorizationUrl.searchParams.set("redirect_uri", redirectUrl);
      authorizationUrl.searchParams.set("state", "state-1234567890");
      await params.onAuthorizationUrl?.(authorizationUrl);
      params.onAuthorizationSession?.({ codeVerifier: "verifier-123", redirectUrl });
      return "redirect";
    },
  );
}

describe("mcp login loopback callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command().exitOverride();
    registerMcpCli(program);
    mocks.readMcpOAuthCredentialsStatus.mockResolvedValue({
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

  it("binds the final redirect before printing it and exchanges the captured code", async () => {
    await withTempHome("openclaw-cli-mcp-loopback-home-", async () => {
      await configureServer();
      const port = await getFreePort();
      const redirectUrl = `http://127.0.0.1:${port}/oauth/callback`;
      mockRedirectFlow(redirectUrl);

      const login = program.parseAsync(["mcp", "login", "docs"], { from: "user" });
      await waitForLog("Waiting for the browser");
      const printedUrlIndex = mocks.runtime.log.mock.calls.findIndex(([line]) =>
        String(line).startsWith("https://auth.example.com/authorize"),
      );
      expect(printedUrlIndex).toBeGreaterThanOrEqual(0);

      const wrong = await fetch(`${redirectUrl}?code=wrong&state=wrong`);
      expect(wrong.status).toBe(400);
      expect(mocks.runMcpOAuthLogin).toHaveBeenCalledOnce();

      const response = await fetch(`${redirectUrl}?code=right&state=state-1234567890`);
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain("Authorization received");
      await login;

      expect(mocks.runMcpOAuthLogin).toHaveBeenCalledTimes(2);
      expect(mocks.runMcpOAuthLogin).toHaveBeenLastCalledWith(
        expect.objectContaining({ authorizationCode: "right" }),
      );
      expect(mocks.runtime.log).toHaveBeenCalledWith('MCP OAuth credentials saved for "docs".');
    });
  });

  it("falls back immediately to the printed manual command when binding fails", async () => {
    await withTempHome("openclaw-cli-mcp-loopback-home-", async () => {
      await configureServer();
      const blocker = createServer();
      await new Promise<void>((resolve) => {
        blocker.listen(0, "127.0.0.1", resolve);
      });
      const address = blocker.address();
      const port = typeof address === "object" && address ? address.port : 0;
      mockRedirectFlow(`http://127.0.0.1:${port}/oauth/callback`);

      await program.parseAsync(["mcp", "login", "docs"], { from: "user" });
      expect(
        mocks.runtime.log.mock.calls.some(([line]) => String(line).includes("Could not start")),
      ).toBe(true);
      expect(mocks.runtime.log.mock.calls.some(([line]) => String(line).includes("--code"))).toBe(
        true,
      );
      expect(mocks.runMcpOAuthLogin).toHaveBeenCalledOnce();
      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      });
    });
  });
});
