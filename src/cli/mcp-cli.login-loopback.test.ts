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
    completeMcpOAuthAuthorization: vi.fn(),
    startMcpOAuthAuthorization: vi.fn(),
    readMcpOAuthCredentialsStatus: vi.fn(),
    createSessionMcpRuntimeOverride: undefined as CreateSessionMcpRuntime | undefined,
  };
});

vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.runtime }));
vi.mock("../mcp/channel-server.js", () => ({ serveOpenClawChannelMcp: vi.fn() }));
vi.mock("../agents/mcp-oauth.js", () => ({
  clearMcpOAuthCredentials: vi.fn(),
  clearMcpOAuthRequesters: vi.fn(),
  clearMcpOAuthServer: vi.fn(),
  completeMcpOAuthAuthorization: mocks.completeMcpOAuthAuthorization,
  countMcpOAuthPrincipals: vi.fn(() => 0),
  readMcpOAuthCredentialsStatus: mocks.readMcpOAuthCredentialsStatus,
  startMcpOAuthAuthorization: mocks.startMcpOAuthAuthorization,
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

function waitForLog(text: string): Promise<void> {
  return new Promise((resolve) => {
    mocks.runtime.log.mockImplementation((line) => {
      if (String(line).includes(text)) {
        resolve();
      }
    });
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
  const authorizationUrl = new URL("https://auth.example.com/authorize");
  authorizationUrl.searchParams.set("redirect_uri", redirectUrl);
  authorizationUrl.searchParams.set("state", "state-1234567890");
  mocks.startMcpOAuthAuthorization.mockResolvedValue({
    status: "redirect",
    authorizationUrl: authorizationUrl.toString(),
    redirectUrl,
    state: "state-1234567890",
  });
  mocks.completeMcpOAuthAuthorization.mockResolvedValue("authorized");
}

describe("mcp login loopback callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtime.log.mockReset();
    program = new Command().exitOverride();
    registerMcpCli(program);
    mocks.readMcpOAuthCredentialsStatus.mockResolvedValue({
      state: "unauthenticated",
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

      const waitingForBrowser = waitForLog("Waiting for the browser");
      const login = program.parseAsync(["mcp", "login", "docs"], { from: "user" });
      await waitingForBrowser;
      const printedUrlIndex = mocks.runtime.log.mock.calls.findIndex(([line]) =>
        String(line).startsWith("https://auth.example.com/authorize"),
      );
      expect(printedUrlIndex).toBeGreaterThanOrEqual(0);

      const wrong = await fetch(`${redirectUrl}?code=wrong&state=wrong`);
      expect(wrong.status).toBe(400);
      expect(mocks.startMcpOAuthAuthorization).toHaveBeenCalledOnce();
      expect(mocks.completeMcpOAuthAuthorization).not.toHaveBeenCalled();

      const response = await fetch(`${redirectUrl}?code=right&state=state-1234567890`);
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain("Authorization received");
      await login;

      expect(mocks.startMcpOAuthAuthorization).toHaveBeenCalledOnce();
      expect(mocks.completeMcpOAuthAuthorization).toHaveBeenCalledOnce();
      expect(mocks.completeMcpOAuthAuthorization.mock.calls[0]?.[2]).toEqual({ code: "right" });
      expect(mocks.runtime.log).toHaveBeenCalledWith('MCP OAuth credentials saved for "docs".');
    });
  });

  it("reports an existing session without starting the loopback", async () => {
    await withTempHome("openclaw-cli-mcp-loopback-home-", async () => {
      await configureServer();
      mocks.startMcpOAuthAuthorization.mockResolvedValue({ status: "authorized" });

      await program.parseAsync(["mcp", "login", "docs"], { from: "user" });

      expect(mocks.runtime.log).toHaveBeenCalledWith('MCP OAuth credentials saved for "docs".');
      expect(mocks.completeMcpOAuthAuthorization).not.toHaveBeenCalled();
      expect(
        mocks.runtime.log.mock.calls.some(([line]) => String(line).includes("Open this URL")),
      ).toBe(false);
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
      expect(mocks.startMcpOAuthAuthorization).toHaveBeenCalledOnce();
      expect(mocks.completeMcpOAuthAuthorization).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      });
    });
  });
});
