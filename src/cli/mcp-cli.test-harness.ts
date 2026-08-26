import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { vi } from "vitest";
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
    clearMcpOAuthRequesters: vi.fn(),
    clearMcpOAuthServer: vi.fn(),
    completeMcpOAuthAuthorization: vi.fn(),
    readMcpOAuthCredentialsStatus: vi.fn(),
    countMcpOAuthPrincipals: vi.fn(),
    startMcpOAuthAuthorization: vi.fn(),
    createSessionMcpRuntimeOverride: undefined as CreateSessionMcpRuntime | undefined,
  };
});

export const mockLog = mocks.runtime.log;
export const mockError = mocks.runtime.error;
export const serveOpenClawChannelMcp = mocks.serveOpenClawChannelMcp;
export const clearMcpOAuthCredentials = mocks.clearMcpOAuthCredentials;
export const completeMcpOAuthAuthorization = mocks.completeMcpOAuthAuthorization;
export const readMcpOAuthCredentialsStatus = mocks.readMcpOAuthCredentialsStatus;
export const countMcpOAuthPrincipals = mocks.countMcpOAuthPrincipals;

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

vi.mock("../mcp/channel-server.js", () => ({
  serveOpenClawChannelMcp: mocks.serveOpenClawChannelMcp,
}));

vi.mock("../agents/mcp-oauth.js", () => ({
  clearMcpOAuthCredentials: mocks.clearMcpOAuthCredentials,
  clearMcpOAuthRequesters: mocks.clearMcpOAuthRequesters,
  clearMcpOAuthServer: mocks.clearMcpOAuthServer,
  completeMcpOAuthAuthorization: mocks.completeMcpOAuthAuthorization,
  readMcpOAuthCredentialsStatus: mocks.readMcpOAuthCredentialsStatus,
  countMcpOAuthPrincipals: mocks.countMcpOAuthPrincipals,
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
let sharedProgram: Command;

export async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-mcp-"));
  tempDirs.push(dir);
  return dir;
}

export async function runMcpCommand(args: string[]) {
  if (!sharedProgram) {
    sharedProgram = new Command();
    sharedProgram.exitOverride();
    registerMcpCli(sharedProgram);
  }
  await sharedProgram.parseAsync(args, { from: "user" });
}

export function setCreateSessionMcpRuntimeOverride(override: CreateSessionMcpRuntime): void {
  mocks.createSessionMcpRuntimeOverride = override;
}

export function lastLogLine(): string {
  return lastRuntimeLine(mockLog);
}

export function lastErrorLine(): string {
  return lastRuntimeLine(mockError);
}

function lastRuntimeLine(mock: typeof mockLog): string {
  const call = mock.mock.calls[mock.mock.calls.length - 1];
  return String(call?.[0] ?? "");
}

export function resetMcpCliTestState(): void {
  vi.clearAllMocks();
  mocks.createSessionMcpRuntimeOverride = undefined;
  readMcpOAuthCredentialsStatus.mockResolvedValue({
    state: "unauthenticated",
  });
  countMcpOAuthPrincipals.mockReturnValue(0);
}

export async function cleanupMcpCliTestState(): Promise<void> {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
}
