/* @vitest-environment jsdom */

import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import {
  disposeTerminalController,
  replaceTerminalController,
} from "./terminal-controller-lifecycle.ts";
import { createTerminalController } from "./terminal-panel.test-support.ts";
import { createIsolatedGhosttyTerminal } from "./terminal-runtime.ts";

const runtimeMocks = vi.hoisted(() => ({
  create: vi.fn(),
  load: vi.fn(),
}));

vi.mock("@openclaw/libterminal/browser", () => ({
  createGhosttyTerminal: runtimeMocks.create,
  loadGhosttyRuntime: runtimeMocks.load,
}));
vi.mock("ghostty-web", () => ({ mockedGhosttyModule: true }));

function terminalController(
  dispose: () => void = vi.fn(),
): GhosttyTerminalController & ReturnType<typeof createTerminalController> {
  return createTerminalController(dispose) as unknown as GhosttyTerminalController &
    ReturnType<typeof createTerminalController>;
}

function terminalRoot() {
  const shell = document.body.appendChild(document.createElement("div"));
  const root = shell.attachShadow({ mode: "open" });
  const external = root.appendChild(document.createElement("input"));
  const previousHost = root.appendChild(document.createElement("div"));
  previousHost.tabIndex = 0;
  return { external, previousHost, root };
}

describe("terminal controller lifecycle", () => {
  afterEach(() => {
    document.body.replaceChildren();
    runtimeMocks.create.mockReset();
    runtimeMocks.load.mockReset();
  });

  it("owns pinned Ghostty listener cleanup before idempotent generic disposal", async () => {
    const underlyingDispose = vi.fn(() => {
      throw new Error("dispose failed");
    });
    const underlying = terminalController(underlyingDispose);
    const handleMouseUp = vi.fn();
    (underlying.terminal as unknown as { handleMouseUp: EventListener }).handleMouseUp =
      handleMouseUp;
    const runtime = { isolated: true };
    runtimeMocks.load.mockResolvedValue(runtime);
    runtimeMocks.create.mockResolvedValue(underlying);
    const removeEventListener = vi.spyOn(document, "removeEventListener");
    const host = document.body.appendChild(document.createElement("div"));

    const controller = await createIsolatedGhosttyTerminal({ parent: host });
    expect(() => disposeTerminalController(controller, host)).not.toThrow();
    expect(() => disposeTerminalController(controller, host)).not.toThrow();

    expect(runtimeMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ parent: host, runtime }),
    );
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith("mouseup", handleMouseUp);
    expect(removeEventListener.mock.invocationCallOrder[0]).toBeLessThan(
      underlyingDispose.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(underlyingDispose).toHaveBeenCalledOnce();
    expect(host.isConnected).toBe(false);
  });

  it.each([
    { focusBefore: "terminal", focusAfter: "replacement" },
    { focusBefore: "external", focusAfter: "external" },
    { focusBefore: "external", focusAfter: "newer" },
  ] as const)(
    "publishes a measurable writable replacement without losing $focusAfter focus",
    async ({ focusBefore, focusAfter }) => {
      const { external, previousHost, root } = terminalRoot();
      const newer = root.appendChild(document.createElement("input"));
      const previous = terminalController();
      const replacement = terminalController();
      const target = { controller: previous, host: previousHost };
      previousHost.style.display = "none";
      previousHost.style.visibility = "visible";
      (focusBefore === "terminal" ? previousHost : external).focus();

      const replaced = await replaceTerminalController(
        target,
        async (host, options) => {
          expect(options).toEqual({ readOnly: true });
          expect(host.style.display).toBe("block");
          expect(host.style.visibility).toBe("hidden");
          expect(host.inert).toBe(true);
          host.tabIndex = 0;
          host.focus();
          setTimeout(() => host.focus(), 0);
          if (focusAfter === "newer") {
            setTimeout(() => newer.focus(), 0);
          }
          return replacement;
        },
        "authoritative replay",
        new AbortController().signal,
      );

      expect(replaced).toBe(true);
      expect(target.controller).toBe(replacement);
      expect(target.host).not.toBe(previousHost);
      expect(target.host.isConnected).toBe(true);
      expect(new TextDecoder().decode(replacement.write.mock.calls[0]?.[0])).toBe(
        "authoritative replay",
      );
      expect(replacement.setReadOnly).toHaveBeenCalledWith(false);
      expect(target.host.style.display).toBe("none");
      expect(target.host.style.visibility).toBe("visible");
      expect(target.host.inert).toBe(false);
      expect(previous.dispose).toHaveBeenCalledOnce();
      expect(root.activeElement).toBe(
        focusAfter === "replacement" ? target.host : focusAfter === "external" ? external : newer,
      );
    },
  );

  it("disposes an aborted unpublished replacement and restores focus it stole", async () => {
    const { external, previousHost, root } = terminalRoot();
    const previous = terminalController();
    const replacement = terminalController();
    const target = { controller: previous, host: previousHost };
    const created = createDeferred<GhosttyTerminalController>();
    const abort = new AbortController();
    let stagedHost: HTMLElement | undefined;
    external.focus();

    const replacing = replaceTerminalController(
      target,
      async (host) => {
        stagedHost = host;
        host.tabIndex = 0;
        host.focus();
        previousHost.remove();
        return created.promise;
      },
      "must not publish",
      abort.signal,
    );
    await vi.waitFor(() => expect(stagedHost).toBeDefined());
    abort.abort();
    created.resolve(replacement);

    await expect(replacing).resolves.toBe(false);
    expect(target).toEqual({ controller: previous, host: previousHost });
    expect(previous.dispose).not.toHaveBeenCalled();
    expect(replacement.write).not.toHaveBeenCalled();
    expect(replacement.dispose).toHaveBeenCalledOnce();
    expect(stagedHost?.isConnected).toBe(false);
    expect(root.activeElement).toBe(external);
  });
});
