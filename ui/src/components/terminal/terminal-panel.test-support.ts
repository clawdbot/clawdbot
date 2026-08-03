import { vi, type Mock } from "vitest";
import { OpenClawTerminalPanel } from "./terminal-panel.ts";

export type CreateOptions = {
  parent: HTMLElement;
  terminalOptions?: {
    fontSize?: number;
    fontFamily?: string;
    theme?: { background?: string; foreground?: string };
  };
  onData?: (bytes: Uint8Array) => void;
  onResize?: (size: { columns: number; rows: number }) => void;
};

export type CreateGhosttyTerminalMock = Mock<
  (options: CreateOptions) => Promise<ReturnType<typeof createTerminalController>>
>;

export function createTerminalController(dispose: () => void = vi.fn()) {
  const wasmTerm = {};
  const renderer = {
    setTheme: vi.fn(),
    render: vi.fn(),
  };
  return {
    readOnly: false,
    terminal: {
      cols: 100,
      rows: 30,
      viewportY: 0,
      wasmTerm,
      renderer,
      write: vi.fn(),
      focus: vi.fn(),
      reset: vi.fn(),
      paste: vi.fn(),
    },
    write: vi.fn(),
    fit: vi.fn(),
    resize: vi.fn(),
    setReadOnly: vi.fn(),
    attach: vi.fn(),
    dispose,
  };
}

export function terminalOpenResult(sessionId: string) {
  return {
    sessionId,
    agentId: "ops",
    shell: "/bin/zsh",
    cwd: "/work/ops",
    confined: false,
  };
}

export function defineTestTerminalPanelElement(
  createGhosttyTerminalMock: CreateGhosttyTerminalMock,
  tagName = `test-openclaw-terminal-panel-${crypto.randomUUID()}`,
): string {
  type TerminalFactory = typeof import("./terminal-runtime.ts").createIsolatedGhosttyTerminal;

  // The full non-isolated UI suite can import the production panel before this
  // test. Override its factory instead of relying on a module mock import order.
  class TestTerminalPanel extends OpenClawTerminalPanel {
    override createTerminalController = createGhosttyTerminalMock as unknown as TerminalFactory;
  }

  customElements.define(tagName, TestTerminalPanel);
  return tagName;
}
