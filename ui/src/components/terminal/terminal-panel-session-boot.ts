import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
import type { TerminalConnection } from "./terminal-connection.ts";
import {
  disposeTerminalController,
  replaceTerminalController,
} from "./terminal-controller-lifecycle.ts";
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_OUTPUT_ENCODER,
  type TerminalPanelSessionControllerHost,
  type TerminalPanelSessionTab,
} from "./terminal-panel-session-types.ts";
import { createTerminalStartupInput } from "./terminal-startup-input.ts";
import { terminalDynamicColors, terminalTheme } from "./terminal-theme.ts";

type TerminalSink = Parameters<TerminalConnection["open"]>[1];

/** Creates the emulator and stream sink; the session controller owns tab adoption. */
export async function bootTerminalPanelSession(params: {
  panel: TerminalPanelSessionControllerHost;
  connection: TerminalConnection;
  sequence: number;
  signal: AbortSignal;
  awaitFirstOutput: boolean;
  isCurrent: () => boolean;
  onReady: (tab: TerminalPanelSessionTab) => void;
  onExit: (tab: TerminalPanelSessionTab, info: Parameters<TerminalSink["onExit"]>[0]) => void;
}) {
  const { panel, connection } = params;
  const host = document.createElement("div");
  host.className = "tp-host";
  // The emulator needs the panel viewport to be laid out before it can measure its grid.
  await panel.updateComplete;
  if (!params.isCurrent()) {
    throw new Error("terminal operation cancelled");
  }
  const viewport = panel.findTerminalPanelViewport();
  if (!viewport) {
    throw new Error("terminal viewport unavailable");
  }
  viewport.append(host);
  const tabReference: { current?: TerminalPanelSessionTab } = {};
  const startupInput = createTerminalStartupInput(
    connection,
    () => tabReference.current?.gatewaySessionId,
  );
  const { createTerminalDefaultColorQueryResponder } =
    await import("@openclaw/libterminal/browser");
  const defaultColorQueries = createTerminalDefaultColorQueryResponder({
    getColors: terminalDynamicColors,
    reply: (data) => startupInput.onData(TERMINAL_OUTPUT_ENCODER.encode(data)),
  });
  const createController = (parent: HTMLElement, controllerOptions?: { readOnly?: boolean }) =>
    panel.createTerminalController({
      parent,
      readOnly: controllerOptions?.readOnly ?? false,
      terminalOptions: {
        fontSize: 11,
        fontFamily: TERMINAL_FONT_FAMILY,
        cursorBlink: true,
        theme: terminalTheme(panel.themeMode),
        scrollback: 5000,
      },
      signal: params.signal,
      // The browser controller owns these subscriptions and their teardown.
      onData: startupInput.onData,
      onResize: startupInput.onResize,
    });
  let controller: GhosttyTerminalController;
  try {
    controller = await createController(host);
  } catch (error) {
    host.remove();
    throw error;
  }
  if (!params.isCurrent()) {
    disposeTerminalController(controller, host);
    throw new Error("terminal operation cancelled");
  }
  const tab: TerminalPanelSessionTab = {
    id: `tab-${params.sequence}`,
    sequence: params.sequence,
    gatewaySessionId: "",
    pendingInput: startupInput.buffer,
    defaultColorQueries,
    shellName: null,
    shell: "",
    agentId: null,
    cwd: null,
    agentOwned: false,
    controller,
    host,
    status: "connecting",
    awaitFirstOutput: params.awaitFirstOutput,
    readyTimer: null,
  };
  tabReference.current = tab;
  const sink: TerminalSink = {
    // Buffered events may replay after the owning session has disposed its tab.
    onData: (data: string) => {
      if (!tab.cancelled) {
        tab.defaultColorQueries.observe(data);
        tab.controller.write(TERMINAL_OUTPUT_ENCODER.encode(data));
        if (data.length > 0) {
          params.onReady(tab);
        }
      }
    },
    onReplay: ({ data, newlyObservedFrom, mode, signal }) => {
      if (tab.cancelled || signal.aborted) {
        return undefined;
      }
      // Suppress historical queries, then answer only the recovered suffix, including split queries.
      tab.defaultColorQueries.primeFromReplay(data.slice(0, newlyObservedFrom));
      tab.defaultColorQueries.observe(data.slice(newlyObservedFrom));
      if (mode === "recovery") {
        return replaceTerminalController(tab, createController, data, signal).then((replaced) => {
          if (replaced && data) {
            params.onReady(tab);
          }
        });
      }
      if (data) {
        tab.controller.write(TERMINAL_OUTPUT_ENCODER.encode(data));
        params.onReady(tab);
      }
      return undefined;
    },
    onExit: (info) => params.onExit(tab, info),
  };
  return {
    tab,
    connection,
    cols: controller.terminal.cols || 80,
    rows: controller.terminal.rows || 24,
    sink,
  };
}
