// Control UI tests cover clipboard copy fallback behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./clipboard.ts";

// jsdom does not implement document.execCommand, so install a controllable mock
// per test and remove it afterwards to keep the fallback path observable.
function mockExecCommand(result: boolean): ReturnType<typeof vi.fn> {
  const exec = vi.fn().mockReturnValue(result);
  (document as unknown as { execCommand: unknown }).execCommand = exec;
  return exec;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (document as unknown as { execCommand?: unknown }).execCommand;
});

describe("copyToClipboard", () => {
  it("returns false without touching the clipboard for empty text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const exec = mockExecCommand(true);

    expect(await copyToClipboard("")).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("uses the async Clipboard API in secure contexts", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const exec = mockExecCommand(true);

    expect(await copyToClipboard("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to execCommand when the Clipboard API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const exec = mockExecCommand(true);

    expect(await copyToClipboard("hello")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("skips fallback when the caller retires a rejected async write", async () => {
    let rejectWrite: ((reason?: unknown) => void) | undefined;
    const writeText = vi.fn().mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const exec = mockExecCommand(true);
    let current = true;

    const copy = copyToClipboard("hello", () => current);
    current = false;
    rejectWrite?.(new Error("denied"));

    expect(await copy).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back to execCommand over plain HTTP where navigator.clipboard is undefined", async () => {
    vi.stubGlobal("navigator", {});
    const exec = mockExecCommand(true);

    expect(await copyToClipboard("hello")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("returns false when both clipboard paths fail", async () => {
    vi.stubGlobal("navigator", {});
    const exec = mockExecCommand(false);

    expect(await copyToClipboard("hello")).toBe(false);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("keeps deferred focus restoration bound to its document after globals retire", async () => {
    vi.stubGlobal("navigator", {});
    mockExecCommand(false);
    vi.useFakeTimers();
    try {
      expect(await copyToClipboard("hello")).toBe(false);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      vi.stubGlobal("document", undefined);
      expect(() => vi.runAllTimers()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it.each(["restore", "newer focus", "removed target"] as const)(
    "restores focus only when still appropriate after the fallback: %s",
    async (state) => {
      vi.stubGlobal("navigator", {});
      mockExecCommand(true);
      const button = document.createElement("button");
      const input = document.createElement("input");
      document.body.append(button);
      button.focus();
      const focus = vi.spyOn(button, "focus");
      button.disabled = true;

      expect(await copyToClipboard("hello")).toBe(true);
      button.disabled = false;
      button.blur();
      if (state === "newer focus") {
        document.body.append(input);
        input.focus();
      } else if (state === "removed target") {
        button.remove();
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
      });
      if (state === "restore") {
        expect(document.activeElement).toBe(button);
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      } else {
        expect(document.activeElement).toBe(state === "newer focus" ? input : document.body);
        expect(focus).not.toHaveBeenCalled();
      }

      button.remove();
      input.remove();
    },
  );
});
