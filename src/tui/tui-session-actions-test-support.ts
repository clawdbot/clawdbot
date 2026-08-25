// Provides typed dependency fixtures for TUI session-action tests.
import { TuiMainScreen, type TUI } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import { ChatLog } from "./components/chat-log.js";
import type { TuiBackend } from "./tui-backend.js";

type TuiSessionList = Awaited<ReturnType<TuiBackend["listSessions"]>>;

export function makeTuiSessionList(overrides: Partial<TuiSessionList> = {}): TuiSessionList {
  const sessions = overrides.sessions ?? [];
  return {
    ts: 0,
    path: "",
    count: sessions.length,
    defaults: {},
    ...overrides,
    sessions,
  };
}

/** Creates a complete backend fixture while keeping scenario overrides type-checked. */
export function makeTuiBackend(overrides: Partial<TuiBackend> = {}): TuiBackend {
  const backend: TuiBackend = {
    connection: { url: "ws://test.invalid" },
    start: vi.fn<TuiBackend["start"]>(),
    stop: vi.fn<TuiBackend["stop"]>(),
    sendChat: vi.fn<TuiBackend["sendChat"]>(async () => ({ runId: "test-run" })),
    abortChat: vi.fn<TuiBackend["abortChat"]>(async () => ({ ok: true, aborted: false })),
    loadHistory: vi.fn<TuiBackend["loadHistory"]>(async () => ({ messages: [] })),
    listSessions: vi.fn<TuiBackend["listSessions"]>(async () => ({
      ts: 0,
      path: "",
      count: 0,
      defaults: {},
      sessions: [],
    })),
    listAgents: vi.fn<TuiBackend["listAgents"]>(async () => ({
      defaultId: "main",
      mainKey: "agent:main:main",
      scope: "global",
      agents: [],
    })),
    patchSession: vi.fn<TuiBackend["patchSession"]>(async () => ({
      ok: true,
      path: "",
      key: "agent:main:main",
      entry: {},
    })),
    createSession: vi.fn<TuiBackend["createSession"]>(async () => ({ ok: true })),
    resetSession: vi.fn<TuiBackend["resetSession"]>(async () => ({ ok: true })),
    getGatewayStatus: vi.fn<TuiBackend["getGatewayStatus"]>(async () => ({})),
    listModels: vi.fn<TuiBackend["listModels"]>(async () => []),
  };
  return { ...backend, ...overrides };
}

/** Creates a real chat log with optional typed method spies. */
export function makeChatLog(): ChatLog;
export function makeChatLog<T extends Partial<ChatLog>>(overrides: T): ChatLog & T;
export function makeChatLog(overrides: Partial<ChatLog> = {}): ChatLog {
  return Object.assign(new ChatLog(), overrides);
}

/** Creates a real TUI backed by an inert terminal and a render spy. */
export function makeTui(overrides: Partial<TUI> = {}): TUI {
  const terminal = {
    start: vi.fn(),
    stop: vi.fn(),
    drainInput: vi.fn(async () => {}),
    write: vi.fn(),
    columns: 120,
    rows: 40,
    kittyProtocolActive: false,
    moveBy: vi.fn(),
    hideCursor: vi.fn(),
    showCursor: vi.fn(),
    clearLine: vi.fn(),
    clearFromCursor: vi.fn(),
    clearScreen: vi.fn(),
    setTitle: vi.fn(),
    setProgress: vi.fn(),
  } satisfies ConstructorParameters<typeof TuiMainScreen>[0];
  const tui = new TuiMainScreen(terminal);
  return Object.assign(tui, { requestRender: vi.fn(), ...overrides });
}
