import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { TuiSessionList } from "../tui/tui-backend.js";
import { resolveResumeSession } from "../tui/tui-session-picker.js";
import { runResumeCommand } from "./resume-cli.runtime.js";

const gatewayMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  runTui: vi.fn(),
  selectStyled: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  error: vi.fn(),
  exit: vi.fn(),
}));

vi.mock("../../packages/terminal-core/src/prompt-select-styled.js", () => ({
  selectStyled: gatewayMocks.selectStyled,
}));

vi.mock("../tui/gateway-chat.js", () => ({
  GatewayChatClient: { connect: gatewayMocks.connect },
}));

vi.mock("../tui/tui.js", () => ({
  resolveGatewayDisconnectState: vi.fn(),
  runTui: gatewayMocks.runTui,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtimeMocks,
}));

type SessionRow = TuiSessionList["sessions"][number];

const sessions: SessionRow[] = [
  { key: "agent:main:alpha", displayName: "Alpha planning", label: "roadmap" },
  { key: "agent:work:beta", displayName: "Beta implementation", label: "checkout" },
  { key: "agent:work:gamma", displayName: "Gamma review", label: "checklist" },
];

const stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function restoreTty(
  stream: NodeJS.ReadStream | NodeJS.WriteStream,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(stream, "isTTY", descriptor);
  } else {
    Reflect.deleteProperty(stream, "isTTY");
  }
}

function createGatewayClient(rows: SessionRow[]) {
  const client = {
    listSessions: vi.fn().mockResolvedValue({ sessions: rows }),
    onConnected: undefined as (() => void) | undefined,
    onConnectError: undefined as ((error: Error) => void) | undefined,
    onDisconnected: undefined as ((reason: string) => void) | undefined,
    start: vi.fn(() => client.onConnected?.()),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  gatewayMocks.connect.mockResolvedValue(client);
  return client;
}

beforeEach(() => {
  gatewayMocks.connect.mockReset();
  gatewayMocks.runTui.mockReset().mockResolvedValue(undefined);
  gatewayMocks.selectStyled.mockReset();
  runtimeMocks.error.mockReset();
  runtimeMocks.exit.mockReset();
});

afterEach(() => {
  restoreTty(process.stdin, stdinTtyDescriptor);
  restoreTty(process.stdout, stdoutTtyDescriptor);
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
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const client = createGatewayClient([]);

    await runResumeCommand("global", {});

    expect(client.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ includeGlobal: false }),
    );
    expect(runtimeMocks.exit).toHaveBeenCalledWith(1);
    expect(gatewayMocks.runTui).not.toHaveBeenCalled();
  });

  it("omits the bare global session from the interactive picker", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const client = createGatewayClient([
      { key: "agent:main:alpha", displayName: "Alpha planning", label: "roadmap" },
    ]);
    gatewayMocks.selectStyled.mockResolvedValue("agent:main:alpha");

    await runResumeCommand(undefined, {});

    expect(client.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ includeGlobal: false }),
    );
    expect(gatewayMocks.selectStyled).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [expect.objectContaining({ value: "agent:main:alpha" })],
      }),
    );
    expect(gatewayMocks.runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        session: "agent:main:alpha",
        forceProcessExitOnReturn: true,
      }),
    );
  });

  it("preserves an explicitly agent-qualified global session", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const client = createGatewayClient([{ key: "global", displayName: "global" }]);

    await runResumeCommand("agent:work:global", {});

    expect(client.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "work", includeGlobal: true }),
    );
    expect(gatewayMocks.runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        session: "agent:work:global",
        forceProcessExitOnReturn: true,
      }),
    );
    expect(parseAgentSessionKey(gatewayMocks.runTui.mock.lastCall?.[0]?.session)).toEqual({
      agentId: "work",
      rest: "global",
    });
  });

  it("rejects a non-interactive queried resume before connecting or launching the TUI", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });

    await expect(runResumeCommand("global", {})).rejects.toThrow(
      "Attaching to a session requires an interactive terminal. Re-run `openclaw resume [query]` from an interactive terminal.",
    );
    expect(gatewayMocks.connect).not.toHaveBeenCalled();
    expect(gatewayMocks.runTui).not.toHaveBeenCalled();
  });
});
