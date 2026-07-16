/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import { OpenClawTerminalPanel } from "./terminal-panel.ts";

type CreateOptions = {
  parent: HTMLElement;
  terminalOptions?: { fontFamily?: string };
  onData?: (bytes: Uint8Array) => void;
  onResize?: (size: { columns: number; rows: number }) => void;
};

function createTerminalController() {
  return {
    readOnly: false,
    terminal: {
      cols: 100,
      rows: 30,
      viewportY: 0,
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
    dispose: vi.fn(),
  };
}

type TerminalFactory = typeof import("./terminal-runtime.ts").createIsolatedGhosttyTerminal;
type CreateGhosttyTerminalMock = Mock<
  (options: CreateOptions) => Promise<ReturnType<typeof createTerminalController>>
>;

const createGhosttyTerminalMock: CreateGhosttyTerminalMock = vi.fn();
const TERMINAL_PANEL_ELEMENT_NAME = `test-openclaw-terminal-panel-upload-${crypto.randomUUID()}`;

class TestTerminalPanel extends OpenClawTerminalPanel {
  protected override createTerminal = createGhosttyTerminalMock as unknown as TerminalFactory;
}

customElements.define(TERMINAL_PANEL_ELEMENT_NAME, TestTerminalPanel);

function terminalUploadFile(name: string, content: string): File {
  const file = new File([content], name);
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode(content).buffer,
  });
  return file;
}

function terminalOpenResult(sessionId: string) {
  return {
    sessionId,
    agentId: "ops",
    shell: "/bin/zsh",
    cwd: "/work/ops",
    confined: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("OpenClawTerminalPanel upload lifecycle", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    document.body.replaceChildren();
    createGhosttyTerminalMock.mockReset();
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  it("uploads dropped files and pastes shell-safe paths without executing", async () => {
    const controller = createTerminalController();
    createGhosttyTerminalMock.mockResolvedValue(controller);
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.open") {
          return terminalOpenResult("session-1") as T;
        }
        if (method === "terminal.upload") {
          return { path: "/tmp/openclaw upload/scan final.pdf", size: 3 } as T;
        }
        return {} as T;
      },
      addEventListener: () => () => {},
    };
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
    panel.toggle();
    await vi.waitFor(() => {
      expect(panel.renderRoot.querySelector<HTMLButtonElement>(".tp-upload")?.disabled).toBe(false);
    });
    expect(panel.renderRoot.querySelector<HTMLInputElement>(".tp-file-input")?.multiple).toBe(true);

    const file = new File(["pdf"], "scan final.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("pdf").buffer,
    });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { types: ["Files"], files: [file], dropEffect: "none" },
    });
    panel.renderRoot.querySelector(".tp-viewport")?.dispatchEvent(drop);

    await vi.waitFor(() => {
      expect(requests).toContainEqual({
        method: "terminal.upload",
        params: {
          sessionId: "session-1",
          name: "scan final.pdf",
          contentBase64: "cGRm",
        },
      });
    });
    expect(controller.terminal.paste).toHaveBeenCalledWith("'/tmp/openclaw upload/scan final.pdf'");
    expect(controller.terminal.paste).not.toHaveBeenCalledWith(expect.stringContaining("\n"));
  });

  it("shows file progress and retries only the failed remainder", async () => {
    const controller = createTerminalController();
    createGhosttyTerminalMock.mockResolvedValue(controller);
    const requests: Array<{ method: string; params: unknown; signal?: AbortSignal }> = [];
    const failedUpload = deferred<{ path: string; size: number }>();
    let notesAttempts = 0;
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown, options?: { signal?: AbortSignal }) => {
        requests.push({ method, params, signal: options?.signal });
        if (method === "terminal.open") {
          return terminalOpenResult("session-1") as T;
        }
        if (method === "terminal.upload") {
          const name = (params as { name: string }).name;
          if (name === "scan final.pdf") {
            return { path: "/tmp/openclaw upload/scan final.pdf", size: 3 } as T;
          }
          notesAttempts += 1;
          if (notesAttempts === 1) {
            return (await failedUpload.promise) as T;
          }
          return { path: "/tmp/openclaw upload/notes.txt", size: 4 } as T;
        }
        return {} as T;
      },
      addEventListener: () => () => {},
    };
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
    panel.toggle();
    await vi.waitFor(() => {
      expect(panel.renderRoot.querySelector<HTMLButtonElement>(".tp-upload")?.disabled).toBe(false);
    });

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        types: ["Files"],
        files: [
          terminalUploadFile("scan final.pdf", "pdf"),
          terminalUploadFile("notes.txt", "note"),
        ],
        dropEffect: "none",
      },
    });
    panel.renderRoot.querySelector(".tp-viewport")?.dispatchEvent(drop);

    await vi.waitFor(() => {
      const progress = panel.renderRoot.querySelector(".tp-upload-progress");
      expect(progress?.getAttribute("aria-valuenow")).toBe("1");
      expect(progress?.getAttribute("aria-valuemax")).toBe("2");
      expect(panel.renderRoot.querySelector(".tp-upload-card")?.textContent).toContain(
        "Uploading 2 of 2",
      );
      expect(panel.renderRoot.querySelector(".tp-upload-card")?.textContent).toContain("notes.txt");
    });
    expect(controller.terminal.paste).not.toHaveBeenCalled();

    failedUpload.reject(
      Object.assign(new Error("paired node went offline"), {
        gatewayCode: "UNAVAILABLE",
        retryable: false,
      }),
    );
    await vi.waitFor(() => {
      const failed = panel.renderRoot.querySelector(".tp-upload-card--failed");
      expect(failed?.textContent).toContain("Upload failed");
      expect(failed?.textContent).toContain("paired node went offline");
      expect(panel.renderRoot.querySelector<HTMLButtonElement>(".tp-upload-retry")).not.toBeNull();
    });
    panel.renderRoot.querySelector<HTMLButtonElement>(".tp-upload-retry")?.click();

    await vi.waitFor(() => {
      expect(controller.terminal.paste).toHaveBeenCalledWith(
        "'/tmp/openclaw upload/scan final.pdf' '/tmp/openclaw upload/notes.txt'",
      );
      expect(panel.renderRoot.querySelector(".tp-upload-card")).toBeNull();
    });
    expect(
      requests
        .filter(({ method }) => method === "terminal.upload")
        .map(({ params }) => (params as { name: string }).name),
    ).toEqual(["scan final.pdf", "notes.txt", "notes.txt"]);
  });

  it("cancels an active batch without pasting staged paths", async () => {
    const controller = createTerminalController();
    createGhosttyTerminalMock.mockResolvedValue(controller);
    const pendingUpload = deferred<{ path: string; size: number }>();
    let uploadSignal: AbortSignal | undefined;
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
        if (method === "terminal.open") {
          return terminalOpenResult("session-1") as T;
        }
        if (method === "terminal.upload") {
          uploadSignal = options?.signal;
          return (await pendingUpload.promise) as T;
        }
        return {} as T;
      },
      addEventListener: () => () => {},
    };
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
    panel.toggle();
    await vi.waitFor(() => {
      expect(panel.renderRoot.querySelector<HTMLButtonElement>(".tp-upload")?.disabled).toBe(false);
    });

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        types: ["Files"],
        files: [terminalUploadFile("archive.zip", "zip")],
        dropEffect: "none",
      },
    });
    panel.renderRoot.querySelector(".tp-viewport")?.dispatchEvent(drop);
    await vi.waitFor(() => {
      expect(panel.renderRoot.querySelector(".tp-upload-card")?.textContent).toContain(
        "Uploading 1 of 1",
      );
    });

    panel.renderRoot.querySelector<HTMLButtonElement>(".tp-upload-cancel")?.click();
    await panel.updateComplete;
    expect(uploadSignal?.aborted).toBe(true);
    expect(panel.renderRoot.querySelector(".tp-upload-card")).toBeNull();
    expect(panel.renderRoot.querySelector<HTMLButtonElement>(".tp-upload")?.disabled).toBe(false);

    pendingUpload.resolve({ path: "/tmp/openclaw upload/archive.zip", size: 3 });
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.terminal.paste).not.toHaveBeenCalled();
  });

  it("cancels a pending upload when its terminal tab closes", async () => {
    const controller = createTerminalController();
    createGhosttyTerminalMock.mockResolvedValue(controller);
    const pendingUpload = deferred<{ path: string; size: number }>();
    let uploadSignal: AbortSignal | undefined;
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
        if (method === "terminal.open") {
          return {
            sessionId: "session-1",
            agentId: "ops",
            shell: "/bin/zsh",
            cwd: "/work/ops",
            confined: false,
          } as T;
        }
        if (method === "terminal.upload") {
          uploadSignal = options?.signal;
          return (await pendingUpload.promise) as T;
        }
        return {} as T;
      },
      addEventListener: () => () => {},
    };
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
    panel.toggle();
    await vi.waitFor(() => {
      expect(panel.renderRoot.querySelector<HTMLButtonElement>(".tp-upload")?.disabled).toBe(false);
    });

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        types: ["Files"],
        files: [terminalUploadFile("archive.zip", "zip")],
        dropEffect: "none",
      },
    });
    panel.renderRoot.querySelector(".tp-viewport")?.dispatchEvent(drop);
    await vi.waitFor(() => {
      expect(panel.renderRoot.querySelector(".tp-upload-card")?.textContent).toContain(
        "Uploading 1 of 1",
      );
    });

    panel.renderRoot.querySelector<HTMLButtonElement>(".tp-tab__close")?.click();
    await vi.waitFor(() => {
      expect(uploadSignal?.aborted).toBe(true);
      expect(panel.renderRoot.querySelector(".tp-upload-card")).toBeNull();
    });

    pendingUpload.reject(new Error("terminal closed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.terminal.paste).not.toHaveBeenCalled();
    expect(panel.renderRoot.querySelector(".tp-upload-card")).toBeNull();
  });
});
