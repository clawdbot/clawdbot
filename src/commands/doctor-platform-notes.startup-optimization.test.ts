// Doctor platform note tests cover startup optimization hints and note output.
import os from "node:os";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noteStartupOptimizationHints } from "./doctor-platform-notes.js";

const { note } = vi.hoisted(() => ({ note: vi.fn() }));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

beforeEach(() => {
  note.mockReset();
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
  vi.spyOn(os, "arch").mockReturnValue("arm64");
  vi.spyOn(os, "totalmem").mockReturnValue(4 * 1024 ** 3);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (platformDescriptor) {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
});

describe("noteStartupOptimizationHints", () => {
  it("does not warn when compile cache and no-respawn are configured", () => {
    noteStartupOptimizationHints({
      NODE_COMPILE_CACHE: "/var/tmp/openclaw-compile-cache",
      OPENCLAW_NO_RESPAWN: "1",
    });

    expect(note).not.toHaveBeenCalled();
  });

  it("warns when compile cache is under /tmp and no-respawn is not set", () => {
    noteStartupOptimizationHints({
      NODE_COMPILE_CACHE: "/tmp/openclaw-compile-cache",
    });

    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = expectDefined<unknown[]>(note.mock.calls[0], "note call 0");
    expect(title).toBe("Startup optimization");
    expect(message).toBe(
      [
        "- NODE_COMPILE_CACHE points to /tmp; use /var/tmp so cache survives reboots and warms startup reliably.",
        "- OPENCLAW_NO_RESPAWN is not set to 1; set it when you want routine gateway restarts to stay in-process instead of handing off to a managed supervisor.",
        "- Suggested env for low-power hosts:",
        "  export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache",
        "  mkdir -p /var/tmp/openclaw-compile-cache",
        "  export OPENCLAW_NO_RESPAWN=1",
      ].join("\n"),
    );
  });

  it("warns when compile cache is disabled via env override", () => {
    noteStartupOptimizationHints({
      NODE_COMPILE_CACHE: "/var/tmp/openclaw-compile-cache",
      OPENCLAW_NO_RESPAWN: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
    });

    expect(note).toHaveBeenCalledTimes(1);
    const [message] = expectDefined<unknown[]>(note.mock.calls[0], "note call 0");
    expect(message).toBe(
      [
        "- NODE_DISABLE_COMPILE_CACHE is set; startup compile cache is disabled.",
        "- Suggested env for low-power hosts:",
        "  export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache",
        "  mkdir -p /var/tmp/openclaw-compile-cache",
        "  export OPENCLAW_NO_RESPAWN=1",
        "  unset NODE_DISABLE_COMPILE_CACHE",
      ].join("\n"),
    );
  });

  it("skips startup optimization note on win32", () => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });

    noteStartupOptimizationHints({
      NODE_COMPILE_CACHE: "/tmp/openclaw-compile-cache",
    });

    expect(note).not.toHaveBeenCalled();
  });

  it("skips startup optimization note on non-target linux hosts", () => {
    vi.mocked(os.arch).mockReturnValue("x64");
    vi.mocked(os.totalmem).mockReturnValue(32 * 1024 ** 3);

    noteStartupOptimizationHints({
      NODE_COMPILE_CACHE: "/tmp/openclaw-compile-cache",
    });

    expect(note).not.toHaveBeenCalled();
  });
});
