import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { startMinimalRealGateway } from "../gateway/minimal-gateway.test-helpers.js";
import type { TuiSessionList } from "../tui/tui-backend.js";
import { resolveResumeSession } from "../tui/tui-session-picker.js";
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

function createGatewayClient(rows: SessionRow[]) {
  const client = {
    listSessions: vi.fn().mockResolvedValue({ sessions: rows }),
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
        session: "agent:main:alpha",
        forceProcessExitOnReturn: true,
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

describe("real Gateway session boundary", () => {
  let harness: Awaited<ReturnType<typeof startMinimalRealGateway>>;

  beforeAll(async () => {
    harness = await startMinimalRealGateway([
      { agentId: "work", key: "agent:work:global", visibility: "shared" },
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
});
