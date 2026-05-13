import { describe, expect, it, vi } from "vitest";
import { noteStartupOptimizationHints } from "./doctor-platform-notes.js";

function firstNoteCall(noteFn: ReturnType<typeof vi.fn>) {
  return noteFn.mock.calls[0] ?? [];
}

describe("noteStartupOptimizationHints", () => {
  it("does not warn when compile cache and no-respawn are configured", () => {
    const noteFn = vi.fn();

    noteStartupOptimizationHints(
      {
        NODE_COMPILE_CACHE: "/var/tmp/openclaw-compile-cache",
        OPENCLAW_NO_RESPAWN: "1",
      },
      { platform: "linux", arch: "arm64", totalMemBytes: 4 * 1024 ** 3, noteFn },
    );

    expect(noteFn).not.toHaveBeenCalled();
  });

  it("warns when compile cache is under /tmp and no-respawn is not set", () => {
    const noteFn = vi.fn();

    noteStartupOptimizationHints(
      {
        NODE_COMPILE_CACHE: "/tmp/openclaw-compile-cache",
      },
      { platform: "linux", arch: "arm64", totalMemBytes: 4 * 1024 ** 3, noteFn },
    );

    expect(noteFn).toHaveBeenCalledTimes(1);
    const [message, title] = firstNoteCall(noteFn);
    expect(title).toBe("Startup optimization");
    expect(message).toBe(
      [
        "- NODE_COMPILE_CACHE points to /tmp; use /var/tmp so cache survives reboots and warms startup reliably.",
        "- OPENCLAW_NO_RESPAWN is not set to 1; set it to avoid extra startup overhead from self-respawn.",
        "- Suggested env for low-power hosts:",
        "  export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache",
        "  mkdir -p /var/tmp/openclaw-compile-cache",
        "  export OPENCLAW_NO_RESPAWN=1",
      ].join("\n"),
    );
  });

  it("warns when compile cache is disabled via env override", () => {
    const noteFn = vi.fn();

    noteStartupOptimizationHints(
      {
        NODE_COMPILE_CACHE: "/var/tmp/openclaw-compile-cache",
        OPENCLAW_NO_RESPAWN: "1",
        NODE_DISABLE_COMPILE_CACHE: "1",
      },
      { platform: "linux", arch: "arm64", totalMemBytes: 4 * 1024 ** 3, noteFn },
    );

    expect(noteFn).toHaveBeenCalledTimes(1);
    const [message] = firstNoteCall(noteFn);
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
    const noteFn = vi.fn();

    noteStartupOptimizationHints(
      {
        NODE_COMPILE_CACHE: "/tmp/openclaw-compile-cache",
      },
      { platform: "win32", arch: "arm64", totalMemBytes: 4 * 1024 ** 3, noteFn },
    );

    expect(noteFn).not.toHaveBeenCalled();
  });

  it("skips startup optimization note on non-target linux hosts", () => {
    const noteFn = vi.fn();

    noteStartupOptimizationHints(
      {
        NODE_COMPILE_CACHE: "/tmp/openclaw-compile-cache",
      },
      { platform: "linux", arch: "x64", totalMemBytes: 32 * 1024 ** 3, noteFn },
    );

    expect(noteFn).not.toHaveBeenCalled();
  });
});
