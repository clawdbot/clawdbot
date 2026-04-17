import { describe, expect, it, vi } from "vitest";
import { logMemoryVectorDegradedWrite } from "./manager-vector-warning.js";

describe("memory vector degradation warnings", () => {
  it("emits the degraded warning only once for a manager", () => {
    const warn = vi.fn();

    const first = logMemoryVectorDegradedWrite({
      vectorEnabled: true,
      vectorReady: false,
      chunkCount: 3,
      warningShown: false,
      loadError: "load failed",
      warn,
    });
    const second = logMemoryVectorDegradedWrite({
      vectorEnabled: true,
      vectorReady: false,
      chunkCount: 2,
      warningShown: first,
      loadError: "load failed",
      warn,
    });

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "chunks_vec not updated — sqlite-vec unavailable: load failed. Vector recall degraded. Further duplicate warnings suppressed.",
    );
  });

  it("skips the warning when vector writes are available", () => {
    const warn = vi.fn();

    const shown = logMemoryVectorDegradedWrite({
      vectorEnabled: true,
      vectorReady: true,
      chunkCount: 1,
      warningShown: false,
      warn,
    });

    expect(shown).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
