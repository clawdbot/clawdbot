/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_PALETTE_OPEN_EVENT } from "../components/command-palette-contract.ts";
import {
  KEYBOARD_SHORTCUTS_REQUEST_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../components/panel-toggle-contract.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  createLazyElementSpec,
  resetAppHostTestGlobals,
  type ShellKeyboardState,
  type TestOptionalCustomElement,
  stubRenderedWhenDefined,
} from "./app-host.test-support.ts";
import "./app-host.ts";
import {
  DEBUG_OVERLAY_ELEMENT,
  KEYBOARD_SHORTCUTS_ELEMENT,
  type LazyCustomElementRequestController,
} from "./lazy-custom-element.ts";
import { readLazyShellAction, SHELL_APPROVALS_OPEN_EVENT } from "./lazy-shell-action.ts";

const recovery = vi.hoisted(() => ({ reload: vi.fn(), pending: new Array<Promise<boolean>>() }));
vi.mock("./stale-chunk-reload.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stale-chunk-reload.ts")>();
  return {
    ...actual,
    retryStaleChunkReloadWhenReachable: (
      deps: Parameters<typeof actual.retryStaleChunkReloadWhenReachable>[0],
    ) => {
      const pending = actual.retryStaleChunkReloadWhenReachable({
        ...deps,
        reload: recovery.reload,
      });
      recovery.pending.push(pending);
      return pending;
    },
  };
});

const storageKey = "openclaw:lazy-event";

type ShellLifecycle = {
  connectedCallback(): void;
  disconnectedCallback(): void;
};

async function withConnectedShell(shell: ShellLifecycle, run: () => void | Promise<void>) {
  shell.connectedCallback();
  try {
    await run();
  } finally {
    shell.disconnectedCallback();
  }
}

afterEach(() => {
  resetAppHostTestGlobals();
  vi.restoreAllMocks();
  recovery.reload.mockClear();
  recovery.pending.length = 0;
});

type PaletteShell = HTMLElement &
  ShellLifecycle & {
    commandPaletteElement: TestOptionalCustomElement;
    lazyCustomElements: LazyCustomElementRequestController;
    openPalette(): void;
    restorePendingLazyAction(): void;
    resetForContextEpoch(): void;
  };

function paletteShell(element: TestOptionalCustomElement, open: () => void): PaletteShell {
  const shell = document.createElement("openclaw-app-shell") as PaletteShell;
  shell.commandPaletteElement = element;
  Object.defineProperty(shell, "updateComplete", { get: () => Promise.resolve(true) });
  Object.defineProperty(shell, "commandPalette", {
    get: () =>
      customElements.get(element.tagName)
        ? { isOpen: false, openPalette: open, togglePalette: open }
        : undefined,
  });
  stubRenderedWhenDefined(shell);
  return shell;
}

function stalePalette() {
  return createLazyElementSpec("command palette", {
    firstError: new Error("Failed to fetch dynamically imported module: palette-old.js"),
  });
}

describe("lazy shell action storage", () => {
  it.each([
    "{",
    JSON.stringify({ eventType: COMMAND_PALETTE_OPEN_EVENT, extra: true }),
    JSON.stringify({ eventType: "openclaw:unknown", detail: {} }),
    JSON.stringify({ eventType: TERMINAL_PANEL_TOGGLE_EVENT, detail: [] }),
  ])("discards malformed state: %s", (raw) => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    storage.setItem(storageKey, raw);

    expect(readLazyShellAction()).toBeNull();
    expect(storage.getItem(storageKey)).toBeNull();
  });
});

describe("shell lazy events", () => {
  it.each(["unavailable", "denied", "replacement-write-failed"] as const)(
    "retries in place without replaying an older action when storage is %s",
    async (mode) => {
      const storage = createStorageMock();
      if (mode === "replacement-write-failed") {
        storage.setItem(storageKey, JSON.stringify({ eventType: SHELL_APPROVALS_OPEN_EVENT }));
      }
      vi.stubGlobal("sessionStorage", mode === "unavailable" ? null : storage);
      if (mode === "denied") {
        Object.defineProperty(globalThis, "sessionStorage", {
          configurable: true,
          get() {
            throw new DOMException("Storage blocked", "SecurityError");
          },
        });
      }
      const head = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", head);
      const open = vi.fn();
      const shell = paletteShell(stalePalette(), open);
      if (mode === "replacement-write-failed") {
        vi.spyOn(storage, "setItem").mockImplementation(() => {
          throw new DOMException("Storage full", "QuotaExceededError");
        });
      }

      await withConnectedShell(shell, async () => {
        shell.openPalette();
        await vi.waitFor(() => expect(shell.lazyCustomElements.visibleState?.status).toBe("error"));
        shell.lazyCustomElements.retry();
        await Promise.all(recovery.pending);

        await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
        expect(recovery.reload).not.toHaveBeenCalled();
        expect(head).not.toHaveBeenCalled();
        expect(readLazyShellAction()).toBeNull();
      });
    },
  );

  it.each(["close", "context-replaced", "disconnected", "new-request"] as const)(
    "does not reload a retired retry after %s while the document probe is pending",
    async (retirement) => {
      vi.stubGlobal("sessionStorage", createStorageMock());
      let resolveHead = (_response: Response): void => {
        throw new Error("Document probe not started");
      };
      const head = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveHead = resolve;
          }),
      );
      vi.stubGlobal("fetch", head);
      const open = vi.fn();
      const shell = paletteShell(stalePalette(), open);

      await withConnectedShell(shell, async () => {
        shell.openPalette();
        await vi.waitFor(() => expect(shell.lazyCustomElements.visibleState?.status).toBe("error"));
        shell.lazyCustomElements.retry();
        await vi.waitFor(() => expect(head).toHaveBeenCalledOnce());

        if (retirement === "close") {
          shell.lazyCustomElements.close();
        } else if (retirement === "context-replaced") {
          shell.resetForContextEpoch();
        } else if (retirement === "disconnected") {
          shell.disconnectedCallback();
        } else {
          shell.lazyCustomElements.request(createLazyElementSpec("new request"));
        }
        resolveHead(new Response(null, { status: 200 }));
        await expect(Promise.all(recovery.pending)).resolves.toEqual([false]);

        expect(recovery.reload).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
      });
    },
  );

  it("repairs stale stored intent before reloading and replays the current action once", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const element = stalePalette();
    const open = vi.fn();
    const shell = paletteShell(element, open);

    shell.openPalette();
    await vi.waitFor(() => expect(shell.lazyCustomElements.visibleState?.status).toBe("error"));
    storage.setItem(storageKey, "{}");
    shell.lazyCustomElements.retry();
    await expect(Promise.all(recovery.pending)).resolves.toEqual([true]);
    expect(recovery.reload).toHaveBeenCalledOnce();
    expect(readLazyShellAction()).toEqual({ eventType: COMMAND_PALETTE_OPEN_EVENT });

    const replacement = paletteShell(element, open);
    await withConnectedShell(replacement, async () => {
      replacement.restorePendingLazyAction();
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
      replacement.restorePendingLazyAction();
      expect(open).toHaveBeenCalledOnce();
      expect(readLazyShellAction()).toBeNull();
    });
  });

  it("requests the keyboard shortcuts dialog even from a focused text input", async () => {
    const requested = vi.fn();
    const toggled = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellKeyboardState &
      ShellLifecycle &
      HTMLElement;
    const dialog = document.createElement(KEYBOARD_SHORTCUTS_ELEMENT.tagName) as HTMLElement & {
      toggle: () => void;
    };
    dialog.toggle = toggled;
    shell.append(dialog);
    Object.defineProperty(shell, "updateComplete", { get: () => Promise.resolve(true) });
    const input = document.body.appendChild(document.createElement("input"));
    const shortcut = new KeyboardEvent("keydown", {
      key: "/",
      code: "Slash",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.addEventListener(KEYBOARD_SHORTCUTS_REQUEST_EVENT, requested);

    try {
      await withConnectedShell(shell, async () => {
        input.dispatchEvent(shortcut);

        expect(shortcut.defaultPrevented).toBe(true);
        expect(requested).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(toggled).toHaveBeenCalledOnce());

        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "/",
            code: "Slash",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        expect(toggled).toHaveBeenCalledTimes(2);
      });
    } finally {
      input.remove();
      window.removeEventListener(KEYBOARD_SHORTCUTS_REQUEST_EVENT, requested);
    }
  });

  it("loads the debug overlay shortcut and ignores editable targets", async () => {
    const toggled = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellKeyboardState &
      ShellLifecycle &
      HTMLElement;
    const overlay = document.createElement(DEBUG_OVERLAY_ELEMENT.tagName) as HTMLElement & {
      toggle: () => void;
    };
    overlay.toggle = toggled;
    shell.append(overlay);
    Object.defineProperty(shell, "updateComplete", { get: () => Promise.resolve(true) });
    const shortcut = new KeyboardEvent("keydown", {
      key: "d",
      code: "KeyD",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });

    await withConnectedShell(shell, async () => {
      shell.handleDocumentKeydown(shortcut);
      expect(shortcut.defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(toggled).toHaveBeenCalledOnce());

      const input = document.body.appendChild(document.createElement("input"));
      input.addEventListener("keydown", (event) => shell.handleDocumentKeydown(event));
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "d",
          code: "KeyD",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(toggled).toHaveBeenCalledOnce();
    });
  });

  it("opens approvals after the modal module loads", async () => {
    const element = createLazyElementSpec("exec approval modal");
    const show = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellLifecycle & {
      approvalOverlay?: { show(): void };
      execApprovalElement: TestOptionalCustomElement;
      openApprovals(): void;
    };
    shell.execApprovalElement = element;
    Object.defineProperty(shell, "updateComplete", { get: () => Promise.resolve(true) });
    Object.defineProperty(shell, "approvalOverlay", {
      get: () => (customElements.get(element.tagName) ? { show } : undefined),
    });
    stubRenderedWhenDefined(shell);

    await withConnectedShell(shell, async () => {
      shell.openApprovals();
      await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
    });
  });
});
