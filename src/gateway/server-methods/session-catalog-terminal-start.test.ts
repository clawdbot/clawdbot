import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { catalogStartHandler } from "./session-catalog-terminal-start.js";

vi.mock("../../state/user-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profiles.js")>()),
  getUserProfileRole: vi.fn(() => null),
}));

function provider(overrides: Partial<SessionCatalogProvider> = {}): SessionCatalogProvider {
  return {
    id: "codex",
    label: "Codex",
    list: vi.fn(async () => []),
    read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    ...overrides,
  };
}

let activeProvider: SessionCatalogProvider;
const resolveCreateTarget = vi.fn((): { ok: true } | { ok: false; message: string } => ({
  ok: true,
}));
const handler = catalogStartHandler(
  (catalogId) => (activeProvider.id === catalogId ? activeProvider : undefined),
  resolveCreateTarget,
);

function startCall(
  params: unknown,
  config: Record<string, unknown> = {},
  client?: {
    authenticatedUserProfile?: { profileId: string };
    connect?: { scopes?: string[] };
    connId?: string;
  },
  contextOverrides: Record<string, unknown> = {},
) {
  const respond = vi.fn();
  const completion = Promise.resolve(
    handler({
      params,
      respond,
      client,
      context: { getRuntimeConfig: () => config, ...contextOverrides },
    } as never),
  );
  return { completion, respond };
}

async function call(
  params: unknown,
  config: Record<string, unknown> = {},
  client?: {
    authenticatedUserProfile?: { profileId: string };
    connect?: { scopes?: string[] };
    connId?: string;
  },
  contextOverrides: Record<string, unknown> = {},
) {
  const pending = startCall(params, config, client, contextOverrides);
  await pending.completion;
  return pending.respond;
}

describe("sessions.catalog.startTerminal", () => {
  beforeAll(async () => {
    await import("./terminal.js");
  });

  beforeEach(() => {
    activeProvider = provider();
    resolveCreateTarget.mockReset();
    resolveCreateTarget.mockReturnValue({ ok: true });
  });

  it("requires the cliAgents opt-in before terminal start", async () => {
    const startTerminalSession = vi.fn();
    activeProvider = provider({ startTerminalSession });

    const respond = await call({
      catalogId: "codex",
      agentId: "main",
      cwd: process.cwd(),
    });

    expect(startTerminalSession).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        message: "CLI agent terminal start is disabled; enable gateway.cliAgents.enabled and retry",
      }),
    );
  });

  it("refuses terminal start when the terminal is disabled", async () => {
    const startTerminalSession = vi.fn();
    activeProvider = provider({ startTerminalSession });

    const respond = await call(
      { catalogId: "codex", agentId: "main", cwd: process.cwd() },
      { gateway: { cliAgents: { enabled: true } } },
      { connId: "conn-1" },
      { isTerminalEnabled: () => false },
    );

    expect(startTerminalSession).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        message: "terminal is disabled; enable gateway.terminal.enabled and retry",
      }),
    );
  });

  it("refuses missing local cwd instead of falling back to home", async () => {
    const startTerminalSession = vi.fn();
    activeProvider = provider({ startTerminalSession });

    const respond = await call(
      { catalogId: "codex", agentId: "main", cwd: "relative/missing" },
      { gateway: { cliAgents: { enabled: true } } },
      { connId: "conn-1" },
      { isTerminalEnabled: () => true, terminalSessions: {} },
    );

    expect(startTerminalSession).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message:
          "cwd must be an existing absolute directory; create or choose a worktree and retry",
      }),
    );
  });

  it("rejects terminal start before resolving a disallowed agent's provider target", async () => {
    const startTerminalSession = vi.fn();
    activeProvider = provider({ startTerminalSession });

    const respond = await call(
      { catalogId: "codex", agentId: "main", cwd: process.cwd() },
      {
        gateway: {
          cliAgents: { enabled: true },
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others: "view" },
                agents: ["research"],
                scopes: ["operator.read", "operator.write"],
              },
            },
          },
        },
      },
      { authenticatedUserProfile: { profileId: "profile-terminal-guest" }, connId: "conn-1" },
      { isTerminalEnabled: () => true, terminalSessions: {} },
    );

    expect(resolveCreateTarget).not.toHaveBeenCalled();
    expect(startTerminalSession).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.FORBIDDEN,
        message: expect.stringContaining('cannot create sessions for agent "main"'),
      }),
    );
  });

  it("rechecks local cwd after the provider plan resolves", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-catalog-start-"));
    let releasePlan!: () => void;
    const planGate = new Promise<void>((resolve) => {
      releasePlan = resolve;
    });
    const startTerminalSession = vi.fn(async () => {
      await planGate;
      return { kind: "local" as const, argv: ["codex"], cwd };
    });
    const open = vi.fn();
    activeProvider = provider({ startTerminalSession });

    try {
      const pending = startCall(
        { catalogId: "codex", agentId: "main", cwd },
        { gateway: { cliAgents: { enabled: true } } },
        { connId: "conn-1", connect: { scopes: ["operator.admin"] } },
        {
          isTerminalEnabled: () => true,
          terminalSessions: { open },
          resolveTerminalLaunchPolicy: () => ({
            ok: true,
            plan: { agentId: "main", cwd: "/agent/workspace", shell: "/bin/zsh", args: [] },
          }),
          isConnectionActive: () => true,
        },
      );
      await vi.waitFor(() => expect(startTerminalSession).toHaveBeenCalledOnce());
      await fs.rm(cwd, { recursive: true });
      releasePlan();
      await pending.completion;

      expect(open).not.toHaveBeenCalled();
      expect(pending.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.INVALID_REQUEST,
          message: expect.stringContaining(
            "cwd is no longer available; recreate or choose the worktree and retry",
          ),
        }),
      );
    } finally {
      releasePlan();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps the terminal recovery hint on provider errors", async () => {
    const cwd = process.cwd();
    const startTerminalSession = vi.fn(async () => {
      throw new Error("provider failed to build a start plan");
    });
    const open = vi.fn();
    activeProvider = provider({ startTerminalSession });

    const respond = await call(
      { catalogId: "codex", agentId: "main", cwd },
      { gateway: { cliAgents: { enabled: true } } },
      { connId: "conn-1", connect: { scopes: ["operator.admin"] } },
      {
        isTerminalEnabled: () => true,
        terminalSessions: { open },
        resolveTerminalLaunchPolicy: () => ({
          ok: true,
          plan: { agentId: "main", cwd: "/agent/workspace", shell: "/bin/zsh", args: [] },
        }),
      },
    );

    expect(open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message:
          "provider failed to build a start plan; check the selected CLI, host, and terminal configuration, then retry",
      }),
    );
  });

  it("rejects local terminal start for a named profile before provider fallback", async () => {
    const cwd = process.cwd();
    const startTerminalSession = vi.fn(async (request: { allowProcessHomeFallback?: boolean }) => {
      throw new Error(
        request.allowProcessHomeFallback === false
          ? "local Test sessions are unavailable in isolated state"
          : "unguarded local terminal start",
      );
    });
    activeProvider = provider({ startTerminalSession: startTerminalSession as never });
    const home = os.userInfo().homedir;
    const stateDir = path.join(home, ".openclaw-dev");

    const respond = await withEnvAsync(
      {
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_HOME: undefined,
        OPENCLAW_PROFILE: "dev",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      async () =>
        await call(
          { catalogId: "codex", agentId: "main", cwd },
          { gateway: { cliAgents: { enabled: true } } },
          { connId: "conn-1", connect: { scopes: ["operator.admin"] } },
          {
            isTerminalEnabled: () => true,
            terminalSessions: { open: vi.fn() },
            resolveTerminalLaunchPolicy: () => ({
              ok: true,
              plan: { agentId: "main", cwd, shell: "/bin/zsh", args: [] },
            }),
            isConnectionActive: () => true,
          },
        ),
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("local Test sessions are unavailable in isolated state"),
      }),
    );
  });

  it("reuses terminal.open admission and manager ownership for terminal start", async () => {
    const cwd = process.cwd();
    const startTerminalSession = vi.fn(async () => ({
      kind: "local" as const,
      argv: ["codex", "--", "Inspect the failing test"],
      cwd,
      title: "Codex",
      env: { CODEX_HOME: "/tmp/codex-home" },
      pathEnv: "/usr/local/bin:/usr/bin:/bin",
    }));
    const open = vi.fn(async () => ({
      ok: true as const,
      sessionId: "terminal-1",
      agentId: "research",
      cwd,
      shell: "/bin/zsh",
    }));
    activeProvider = provider({ startTerminalSession });

    const config = { gateway: { cliAgents: { enabled: true } } };
    const respond = await call(
      {
        catalogId: "codex",
        hostId: "gateway:local",
        agentId: "research",
        cwd,
        initialMessage: "Inspect the failing test",
      },
      config,
      { connId: "conn-1", connect: { scopes: ["operator.admin"] } },
      {
        isTerminalEnabled: () => true,
        terminalSessions: { open },
        resolveTerminalLaunchPolicy: () => ({
          ok: true,
          plan: { agentId: "research", cwd: "/agent/workspace", shell: "/bin/zsh", args: [] },
        }),
        isConnectionActive: () => true,
        logGateway: { info: vi.fn() },
      },
    );

    expect(resolveCreateTarget).toHaveBeenCalledWith("codex", "research", config);
    expect(startTerminalSession).toHaveBeenCalledWith({
      agentId: "research",
      allowProcessHomeFallback: false,
      cwd,
      initialMessage: "Inspect the failing test",
    });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: { kind: "conn", connId: "conn-1" },
        agentId: "research",
        cwd,
        shell: "/bin/zsh",
        args: ["-il", "-c", "'codex' '--' 'Inspect the failing test'"],
        cols: 80,
        rows: 24,
        env: expect.objectContaining({
          CODEX_HOME: "/tmp/codex-home",
          PATH: "/usr/local/bin:/usr/bin:/bin",
        }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, {
      sessionId: "terminal-1",
      agentId: "research",
      cwd,
      shell: "/bin/zsh",
      confined: false,
      title: "Codex",
    });
  });

  it("does not fall back to local when a node host was requested", async () => {
    const startTerminalSession = vi.fn(async ({ cwd }: { cwd: string }) => ({
      kind: "local" as const,
      argv: ["codex"],
      cwd,
    }));
    const open = vi.fn();
    activeProvider = provider({ startTerminalSession });

    const respond = await call(
      { catalogId: "codex", hostId: "node:remote", agentId: "main", cwd: "/remote/worktree" },
      { gateway: { cliAgents: { enabled: true } } },
      { connId: "conn-1", connect: { scopes: ["operator.admin"] } },
      {
        isTerminalEnabled: () => true,
        terminalSessions: { open },
        resolveTerminalLaunchPolicy: () => ({
          ok: true,
          plan: { agentId: "main", cwd: "/agent/workspace", shell: "/bin/zsh", args: [] },
        }),
      },
    );

    expect(startTerminalSession).toHaveBeenCalledWith({
      agentId: "main",
      allowProcessHomeFallback: false,
      cwd: "/remote/worktree",
      nodeId: "remote",
    });
    expect(open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("cannot start on the selected node"),
      }),
    );
  });

  it("refuses sandboxed agents before requesting a terminal plan", async () => {
    const startTerminalSession = vi.fn();
    activeProvider = provider({ startTerminalSession });

    const respond = await call(
      { catalogId: "codex", agentId: "locked", cwd: process.cwd() },
      { gateway: { cliAgents: { enabled: true } } },
      { connId: "conn-1", connect: { scopes: ["operator.admin"] } },
      {
        isTerminalEnabled: () => true,
        terminalSessions: { open: vi.fn() },
        resolveTerminalLaunchPolicy: () => ({
          ok: false,
          block: { kind: "sandboxed", agentId: "locked", mode: "all" },
        }),
      },
    );

    expect(startTerminalSession).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining('agent "locked" runs in a sandbox'),
      }),
    );
  });
});
