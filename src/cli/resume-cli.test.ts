import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceAuthTokenRecord } from "../../packages/gateway-client/src/client.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { startMinimalRealGateway } from "../gateway/minimal-gateway.test-helpers.js";
import { encodeResumeHandoff } from "../shared/resume-handoff.js";
import type { TuiSessionList } from "../tui/tui-backend.js";
import { resolveResumeSession } from "../tui/tui-session-picker.js";
import { registerResumeCli } from "./resume-cli.js";
import { runResumeCommand } from "./resume-cli.runtime.js";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
  runTui: vi.fn(),
  selectStyled: vi.fn(),
}));

vi.mock("../../packages/terminal-core/src/prompt-select-styled.js", () => ({
  selectStyled: mocks.selectStyled,
}));

vi.mock("../tui/gateway-chat.js", () => ({
  GatewayChatClient: { connect: mocks.connect },
}));

vi.mock("../tui/tui.js", () => ({
  resolveGatewayDisconnectState: vi.fn(),
  runTui: mocks.runTui,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks,
}));

type SessionRow = TuiSessionList["sessions"][number];

const sessions: SessionRow[] = [
  { key: "agent:main:alpha", displayName: "Alpha planning", label: "roadmap" },
  { key: "agent:work:beta", displayName: "Beta implementation", label: "checkout" },
  { key: "agent:work:gamma", displayName: "Gamma review", label: "checklist" },
];

const ttyDescriptors = [process.stdin, process.stdout].map(
  (stream) => [stream, Object.getOwnPropertyDescriptor(stream, "isTTY")] as const,
);

function createGatewayClient(
  rows: SessionRow[],
  connection: {
    url: string;
    token?: string;
    password?: string;
    tlsFingerprint?: string;
  } = {
    url: "wss://resolved.example/control",
    token: "resolved-token",
    tlsFingerprint: "sha256:resolved-pin",
  },
) {
  const client = {
    connection,
    listSessions: vi.fn().mockResolvedValue({ sessions: rows }),
    resolveSession: vi.fn(),
    onConnected: undefined as (() => void) | undefined,
    onConnectError: undefined as ((error: Error) => void) | undefined,
    onDisconnected: undefined as ((reason: string) => void) | undefined,
    start: vi.fn(() => client.onConnected?.()),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  mocks.connect.mockResolvedValue(client);
  return client;
}

beforeEach(() => {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  mocks.connect.mockReset();
  mocks.runTui.mockReset().mockResolvedValue(undefined);
  mocks.selectStyled.mockReset();
  mocks.error.mockReset();
  mocks.exit.mockReset();
});

afterEach(() => {
  for (const [stream, descriptor] of ttyDescriptors) {
    void (descriptor
      ? Object.defineProperty(stream, "isTTY", descriptor)
      : Reflect.deleteProperty(stream, "isTTY"));
  }
});

describe("resolveResumeSession", () => {
  it.each([
    {
      name: "exact key wins over another session name",
      query: "agent:main:alpha",
      rows: [...sessions, { key: "agent:other:delta", displayName: "agent:main:alpha" }],
      expected: { kind: "match", key: "agent:main:alpha" },
    },
    {
      name: "unique key substring",
      query: "work:beta",
      rows: sessions,
      expected: { kind: "match", key: "agent:work:beta" },
    },
    {
      name: "unique display-name substring",
      query: "implementation",
      rows: sessions,
      expected: { kind: "match", key: "agent:work:beta" },
    },
    {
      name: "unique fuzzy display-name match",
      query: "bt impl",
      rows: sessions,
      expected: { kind: "match", key: "agent:work:beta" },
    },
    {
      name: "ambiguous label substring",
      query: "check",
      rows: sessions,
      expected: {
        kind: "ambiguous",
        keys: ["agent:work:beta", "agent:work:gamma"],
      },
    },
    {
      name: "no match",
      query: "unrelated-session-name",
      rows: sessions,
      expected: { kind: "none" },
    },
  ])("resolves $name", ({ query, rows, expected }) => {
    const result = resolveResumeSession(rows, query);
    if (result.kind === "match") {
      expect({ kind: result.kind, key: result.session.value }).toEqual(expected);
      return;
    }
    if (result.kind === "ambiguous") {
      expect({
        kind: result.kind,
        keys: result.candidates.map((candidate) => candidate.value),
      }).toEqual(expected);
      return;
    }
    expect(result).toEqual(expected);
  });
});

describe("runResumeCommand", () => {
  it.each([
    ["malformed", "not+base64url"],
    ["oversized", "A".repeat(4097)],
  ])("rejects a %s handoff before Gateway discovery or the TUI", async (_name, handoff) => {
    await expect(runResumeCommand(undefined, { handoff })).rejects.toThrow(
      "Invalid --handoff payload. Copy a fresh command from the Control UI.",
    );
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.runTui).not.toHaveBeenCalled();
  });

  it.each([
    ["a positional query", "agent:main:other", undefined],
    ["an explicit URL", undefined, "wss://other.example/ws"],
  ])("rejects a handoff combined with %s", async (_name, query, url) => {
    const handoff = encodeResumeHandoff({
      sessionKey: "agent:main:alpha",
      gatewayUrl: "wss://gateway.example/openclaw",
    });

    await expect(runResumeCommand(query, { handoff, ...(url ? { url } : {}) })).rejects.toThrow(
      "--handoff cannot be combined with a positional query or --url.",
    );
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.runTui).not.toHaveBeenCalled();
  });

  it("passes an exact handoff target and explicit auth directly into the bound TUI", async () => {
    const sessionKey = "agent:main: hostile-'\"$&;|<>^()%![]{}\\`-%PATH% ";
    const url = "wss://gateway.example/openclaw/$&;=()+,![]{}'`/%25PATH%25";
    const handoff = encodeResumeHandoff({ sessionKey, gatewayUrl: url });
    const client = createGatewayClient([], {
      url: "wss://normalized.example/different-path",
      token: "explicit-token",
      password: "explicit-password",
      tlsFingerprint: "sha256:explicit-pin",
    });
    client.resolveSession.mockResolvedValue({ ok: true, key: sessionKey, agentId: "main" });

    await runResumeCommand(undefined, {
      handoff,
      token: "explicit-token",
      password: "explicit-password",
      tlsFingerprint: "sha256:explicit-pin",
    });

    expect(mocks.connect).toHaveBeenCalledWith({
      url,
      token: "explicit-token",
      password: "explicit-password",
      tlsFingerprint: "sha256:explicit-pin",
      allowConfiguredAuthForExactTarget: true,
      suppressEnvAuthFallback: true,
    });
    expect(client.resolveSession).toHaveBeenCalledExactlyOnceWith({
      key: sessionKey,
      agentId: "main",
      includeGlobal: true,
      allowMissing: true,
    });
    expect(client.listSessions).not.toHaveBeenCalled();
    expect(mocks.runTui).toHaveBeenCalledWith({
      boundGateway: {
        url,
        token: "explicit-token",
        password: "explicit-password",
        tlsFingerprint: "sha256:explicit-pin",
      },
      session: sessionKey,
      forceProcessExitOnReturn: true,
    });
  });

  it.each([
    ["missing", { ok: true, missing: true }, "This session is no longer available."],
    [
      "ambiguous",
      {
        ok: true,
        ambiguous: true,
        candidates: [{ key: "agent:main:one", agentId: "main", displayName: "One" }],
      },
      "Could not resolve the session handoff.",
    ],
    [
      "domain error",
      { ok: false, error: { code: "INVALID_REQUEST", message: "invalid handoff" } },
      "Could not resolve the session handoff.",
    ],
    ["projected missing", { ok: false }, "Could not resolve the session handoff."],
    [
      "projected ambiguity",
      { ok: false, candidates: [{ key: "agent:main:one" }] },
      "Could not resolve the session handoff.",
    ],
    ["malformed success", { ok: true }, "Could not resolve the session handoff."],
    [
      "old success without agent ownership",
      { ok: true, key: "agent:main:alpha" },
      "Could not resolve the session handoff.",
    ],
    [
      "extra success field",
      { ok: true, key: "agent:main:alpha", agentId: "main", extra: true },
      "Could not resolve the session handoff.",
    ],
    [
      "empty success owner",
      { ok: true, key: "agent:main:alpha", agentId: "" },
      "Could not resolve the session handoff.",
    ],
    [
      "old ambiguity candidate without agent ownership",
      { ok: true, ambiguous: true, candidates: [{ key: "agent:main:one" }] },
      "Could not resolve the session handoff.",
    ],
    [
      "malformed candidate",
      {
        ok: true,
        ambiguous: true,
        candidates: [{ key: "agent:main:one", agentId: "main", extra: true }],
      },
      "Could not resolve the session handoff.",
    ],
    [
      "mismatched returned agent",
      { ok: true, key: "agent:main:alpha", agentId: "work" },
      "Could not resolve the session handoff.",
    ],
    [
      "unqualified canonical key",
      { ok: true, key: "alpha", agentId: "main" },
      "Could not resolve the session handoff.",
    ],
    [
      "mismatched canonical key owner",
      { ok: true, key: "agent:work:alpha", agentId: "main" },
      "Could not resolve the session handoff.",
    ],
    [
      "malformed error",
      {
        ok: false,
        error: { code: "INVALID_REQUEST", message: "invalid handoff", retryAfterMs: -1 },
      },
      "Could not resolve the session handoff.",
    ],
    [
      "extra error field",
      {
        ok: false,
        error: { code: "INVALID_REQUEST", message: "invalid handoff", extra: true },
      },
      "Could not resolve the session handoff.",
    ],
  ])(
    "rejects a %s handoff resolution without discovery or TUI launch",
    async (_name, result, message) => {
      const handoff = encodeResumeHandoff({
        sessionKey: "agent:main:alpha",
        gatewayUrl: "wss://gateway.example/openclaw",
      });
      const client = createGatewayClient([]);
      client.resolveSession.mockResolvedValue(result);

      await expect(runResumeCommand(undefined, { handoff })).rejects.toThrow(message);
      expect(client.listSessions).not.toHaveBeenCalled();
      expect(mocks.runTui).not.toHaveBeenCalled();
    },
  );

  it("rejects a handoff resolution RPC error without exposing it or launching the TUI", async () => {
    const handoff = encodeResumeHandoff({
      sessionKey: "agent:main:alpha",
      gatewayUrl: "wss://gateway.example/openclaw",
    });
    const client = createGatewayClient([]);
    client.resolveSession.mockRejectedValue(new Error("sensitive upstream details"));

    await expect(runResumeCommand(undefined, { handoff })).rejects.toThrow(
      "Could not resolve the session handoff. Copy a fresh command from the Control UI.",
    );
    expect(client.listSessions).not.toHaveBeenCalled();
    expect(mocks.runTui).not.toHaveBeenCalled();
  });

  it("excludes the bare global session from query resolution", async () => {
    const client = createGatewayClient([]);

    await runResumeCommand("global", {});

    expect(client.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ includeGlobal: false }),
    );
    expect(mocks.exit).toHaveBeenCalledWith(1);
    expect(mocks.runTui).not.toHaveBeenCalled();
  });

  it("omits the bare global session from the interactive picker", async () => {
    const client = createGatewayClient([
      { key: "agent:main:alpha", displayName: "Alpha planning", label: "roadmap" },
    ]);
    mocks.selectStyled.mockResolvedValue("agent:main:alpha");

    await runResumeCommand(undefined, {});

    expect(client.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ includeGlobal: false }),
    );
    expect(mocks.selectStyled).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [expect.objectContaining({ value: "agent:main:alpha" })],
      }),
    );
    expect(mocks.runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        boundGateway: {
          url: "wss://resolved.example/control",
          token: "resolved-token",
          tlsFingerprint: "sha256:resolved-pin",
        },
        session: "agent:main:alpha",
        forceProcessExitOnReturn: true,
      }),
    );
  });

  it("resolves the resume connection once and hands it to the TUI as bound", async () => {
    createGatewayClient([
      { key: "agent:main:alpha", displayName: "Alpha planning", label: "roadmap" },
    ]);

    await runResumeCommand("agent:main:alpha", { url: "wss://gateway.example/control" });

    expect(mocks.connect).toHaveBeenCalledWith({
      url: "wss://gateway.example/control",
    });
    expect(mocks.runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        boundGateway: {
          url: "wss://resolved.example/control",
          token: "resolved-token",
          tlsFingerprint: "sha256:resolved-pin",
        },
        session: "agent:main:alpha",
      }),
    );
  });

  it("rejects a non-interactive queried resume before connecting or launching the TUI", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });

    await expect(runResumeCommand("global", {})).rejects.toThrow(
      "Attaching to a session requires an interactive terminal. Re-run `openclaw resume [query]` from an interactive terminal.",
    );
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.runTui).not.toHaveBeenCalled();
  });
});

describe("resume command registration", () => {
  it("documents the additive opaque handoff option", () => {
    const program = new Command().name("openclaw");
    registerResumeCli(program);

    expect(program.commands[0]?.helpInformation()).toContain("--handoff <payload>");
  });
});

describe("real Gateway session boundary", () => {
  let harness: Awaited<ReturnType<typeof startMinimalRealGateway>>;

  beforeAll(async () => {
    harness = await startMinimalRealGateway([
      { agentId: "work", key: "agent:work:global", visibility: "shared" },
      { agentId: "main", key: "agent:main:alpha" },
    ]);
  });

  afterAll(() => harness.close());

  it("preserves an agent-qualified global session through the TUI handoff", async () => {
    const { GatewayChatClient } =
      await vi.importActual<typeof import("../tui/gateway-chat.js")>("../tui/gateway-chat.js");
    mocks.connect.mockImplementation((options) => GatewayChatClient.connect(options));
    await runResumeCommand("agent:work:global", { url: harness.url, token: harness.token });

    expect(harness.sessionListRequests).toContainEqual(
      expect.objectContaining({ agentId: "work", includeGlobal: true }),
    );
    expect(mocks.runTui).toHaveBeenCalledWith(
      expect.objectContaining({ session: "agent:work:global", forceProcessExitOnReturn: true }),
    );
  });

  it("canonicalizes a case-variant handoff through the real sessions.resolve boundary", async () => {
    const { GatewayChatClient } =
      await vi.importActual<typeof import("../tui/gateway-chat.js")>("../tui/gateway-chat.js");
    mocks.connect.mockImplementation((options) => GatewayChatClient.connect(options));
    const rawSessionKey = "Agent:Main:ALPHA";
    const handoff = encodeResumeHandoff({ sessionKey: rawSessionKey, gatewayUrl: harness.url });

    await runResumeCommand(undefined, { handoff, token: harness.token });

    expect(harness.sessionResolveRequests).toContainEqual({
      key: rawSessionKey,
      agentId: "main",
      includeGlobal: true,
      allowMissing: true,
    });
    expect(mocks.runTui).toHaveBeenCalledWith(
      expect.objectContaining({ session: "agent:main:alpha", forceProcessExitOnReturn: true }),
    );
  });

  it("accepts a bootstrap-signed identity and rejects a mismatched signature", async () => {
    await expect(harness.connectBootstrap()).resolves.toMatchObject({ ok: true });
    expect(harness.hellos).toContainEqual(expect.objectContaining({ type: "hello-ok" }));

    await harness.connectBootstrap(true);
    expect(harness.connectFailures).toContainEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          code: ConnectErrorDetailCodes.DEVICE_AUTH_SIGNATURE_INVALID,
        }),
      }),
    );
  });

  it("retires the one-use bootstrap credential before a real-wire reconnect", async () => {
    const { GatewayClient } =
      await vi.importActual<typeof import("../gateway/client.js")>("../gateway/client.js");
    const authState: { value: DeviceAuthTokenRecord | null } = { value: null };
    const storeDeviceAuthToken = vi.fn(({ token, scopes }: { token: string; scopes: string[] }) => {
      authState.value = { token, scopes };
    });
    let helloCount = 0;
    const client = new GatewayClient({
      url: harness.url,
      bootstrapToken: await harness.issueNodeBootstrapToken(),
      preferBootstrapToken: true,
      role: "node",
      scopes: [],
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientVersion: "test",
      platform: "test",
      mode: GATEWAY_CLIENT_MODES.NODE,
      deviceIdentity: harness.createDeviceIdentity("reconnect"),
      hostDeps: {
        loadDeviceAuthToken: () => authState.value,
        storeDeviceAuthToken,
      },
      onHelloOk: () => {
        helloCount += 1;
      },
    });
    client.start();
    try {
      await vi.waitFor(() => expect(helloCount).toBe(1), { timeout: 5_000 });
      expect(storeDeviceAuthToken).toHaveBeenCalledOnce();
      expect(storeDeviceAuthToken).toHaveBeenCalledWith(
        expect.objectContaining({
          token: expect.stringMatching(/\S/),
          scopes: expect.any(Array),
        }),
      );
      expect(authState.value?.token).toBeTruthy();

      await harness.restart();
      await vi.waitFor(() => expect(helloCount).toBe(2), { timeout: 5_000 });
    } finally {
      await client.stopAndWait();
    }
  });
});
