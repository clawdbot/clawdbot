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

  it("restores focus after the execCommand fallback", async () => {
    vi.stubGlobal("navigator", {});
    mockExecCommand(true);
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    const focus = vi.spyOn(button, "focus");
    button.disabled = true;

    expect(await copyToClipboard("hello")).toBe(true);
    button.disabled = false;
    button.blur();
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
    expect(document.activeElement).toBe(button);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });

    button.remove();
  });
});
