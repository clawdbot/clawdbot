// Verifies local shell process handling for TUI local mode.
import { EventEmitter } from "node:events";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createLocalShellRunner } from "./tui-local-shell.js";

const createSelector = () => {
  const selector = {
    onSelect: undefined as ((item: { value: string; label: string }) => void) | undefined,
    onCancel: undefined as (() => void) | undefined,
    render: () => ["selector"],
    invalidate: () => {},
  };
  return selector;
};

function createOverlayHandle(): OverlayHandle {
  return {
    hide: vi.fn(),
    setHidden: vi.fn(),
    isHidden: vi.fn(() => false),
    focus: vi.fn(),
    unfocus: vi.fn(),
    isFocused: vi.fn(() => true),
  };
}

function createShellHarness(params?: {
  spawnCommand?: typeof import("node:child_process").spawn;
  getCwd?: () => string | undefined;
  env?: Record<string, string>;
  maxOutputChars?: number;
}) {
  const messages: string[] = [];
  const chatLog = {
    addSystem: (line: string) => {
      messages.push(line);
    },
  };
  const tui = { requestRender: vi.fn() };
  const overlayHandle = createOverlayHandle();
  const openOverlay = vi.fn(() => overlayHandle);
  const closeOverlay = vi.fn();
  let lastSelector: ReturnType<typeof createSelector> | null = null;
  const createSelectorSpy = vi.fn(() => {
    lastSelector = createSelector();
    return lastSelector;
  });
  const spawnCommand = params?.spawnCommand ?? vi.fn();
  const { runLocalShellLine } = createLocalShellRunner({
    chatLog,
    tui,
    openOverlay,
    closeOverlay,
    createSelector: createSelectorSpy,
    spawnCommand,
    ...(params?.getCwd ? { getCwd: params.getCwd } : {}),
    ...(params?.env ? { env: params.env } : {}),
    ...(params?.maxOutputChars !== undefined ? { maxOutputChars: params.maxOutputChars } : {}),
  });
  return {
    messages,
    openOverlay,
    overlayHandle,
    closeOverlay,
    createSelectorSpy,
    spawnCommand,
    runLocalShellLine,
    getLastSelector: () => lastSelector,
  };
}

function requireSpawnOptions(spawnCommand: ReturnType<typeof vi.fn>): {
  env?: Record<string, string>;
} {
  const call = spawnCommand.mock.calls[0];
  if (!call) {
    throw new Error("expected spawn command call");
  }
  return call[1] as { env?: Record<string, string> };
}

describe("createLocalShellRunner", () => {
  it("logs denial on subsequent ! attempts without re-prompting", async () => {
    const harness = createShellHarness();

    const firstRun = harness.runLocalShellLine("!ls");
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    const selector = harness.getLastSelector();
    selector?.onSelect?.({ value: "no", label: "No" });
    await firstRun;

    await harness.runLocalShellLine("!pwd");

    expect(harness.messages).toContain("local shell: not enabled");
    expect(harness.messages).toContain("local shell: not enabled for this session");
    expect(harness.createSelectorSpy).toHaveBeenCalledTimes(1);
    expect(harness.spawnCommand).not.toHaveBeenCalled();
    expect(harness.closeOverlay).toHaveBeenCalledWith(harness.overlayHandle);
  });

  it("sets OPENCLAW_SHELL when running local shell commands", async () => {
    const spawnCommand = vi.fn((_command: string, _options: unknown) => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      return {
        stdout,
        stderr,
        on: (event: string, callback: (...args: unknown[]) => void) => {
          if (event === "close") {
            setImmediate(() => callback(0, null));
          }
        },
      };
    });

    const harness = createShellHarness({
      spawnCommand: spawnCommand as unknown as typeof import("node:child_process").spawn,
      env: { PATH: "/tmp/bin", USER: "dev" },
    });

    const firstRun = harness.runLocalShellLine("!echo hi");
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    const selector = harness.getLastSelector();
    selector?.onSelect?.({ value: "yes", label: "Yes" });
    await firstRun;

    expect(harness.createSelectorSpy).toHaveBeenCalledTimes(1);
    expect(spawnCommand).toHaveBeenCalledTimes(1);
    const spawnOptions = requireSpawnOptions(spawnCommand);
    expect(spawnOptions.env?.OPENCLAW_SHELL).toBe("tui-local");
    expect(spawnOptions.env?.PATH).toBe("/tmp/bin");
    expect(harness.messages).toContain("local shell: enabled for this session");
  });

  it("keeps stderr visible instead of evicting it when stdout fills the output cap", async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const spawnCommand = vi.fn(() => ({
      stdout,
      stderr,
      on: (event: string, callback: (...args: unknown[]) => void) => {
        if (event === "close") {
          setImmediate(() => {
            // stdout fills the entire cap; stderr then carries the failure reason.
            stdout.emit("data", Buffer.from("0".repeat(20)));
            stderr.emit("data", Buffer.from("FATAL"));
            callback(0, null);
          });
        }
      },
    }));

    const harness = createShellHarness({
      spawnCommand: spawnCommand as unknown as typeof import("node:child_process").spawn,
      maxOutputChars: 20,
    });

    const run = harness.runLocalShellLine("!noisy");
    harness.getLastSelector()?.onSelect?.({ value: "yes", label: "Yes" });
    await run;

    // The failure reason in stderr must survive even though stdout filled the cap;
    // the previous head-cut kept all stdout and dropped stderr entirely.
    expect(harness.messages.some((m) => m.includes("FATAL"))).toBe(true);
  });

  it("keeps a whole code point when the combined output tail starts inside an emoji", async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const spawnCommand = vi.fn(() => ({
      stdout,
      stderr,
      on: (event: string, callback: (...args: unknown[]) => void) => {
        if (event === "close") {
          setImmediate(() => {
            stdout.emit("data", Buffer.from("x😀"));
            stderr.emit("data", Buffer.from("tail"));
            callback(0, null);
          });
        }
      },
    }));
    const harness = createShellHarness({
      spawnCommand: spawnCommand as unknown as typeof import("node:child_process").spawn,
      maxOutputChars: 6,
    });

    const run = harness.runLocalShellLine("!unicode");
    harness.getLastSelector()?.onSelect?.({ value: "yes", label: "Yes" });
    await run;

    expect(harness.messages).toContain("[local] tail");
    expect(harness.messages.join("\n")).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("refuses to retarget local commands after the working directory is deleted", async () => {
    const harness = createShellHarness({ getCwd: () => undefined });

    const run = harness.runLocalShellLine("!pwd");
    harness.getLastSelector()?.onSelect?.({ value: "yes", label: "Yes" });
    await run;

    expect(harness.spawnCommand).not.toHaveBeenCalled();
    expect(harness.messages).toContain(
      "local shell: working directory was deleted; cd to an existing directory first",
    );
  });

  it("does not crash when stdout or stderr emit an error event", async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const spawnCommand = vi.fn(() => ({
      stdout,
      stderr,
      on: (event: string, callback: (...args: unknown[]) => void) => {
        if (event === "close") {
          setImmediate(() => callback(0, null));
        }
      },
    }));
    const harness = createShellHarness({
      spawnCommand: spawnCommand as unknown as typeof import("node:child_process").spawn,
    });

    const run = harness.runLocalShellLine("!cmd");
    harness.getLastSelector()?.onSelect?.({ value: "yes", label: "Yes" });
    await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledTimes(1));
    stdout.emit("error", new Error("EPIPE"));
    stderr.emit("error", new Error("EIO"));

    await expect(run).resolves.toBeUndefined();
    expect(harness.messages.some((message) => message.includes("exit 0"))).toBe(true);
  });
});
