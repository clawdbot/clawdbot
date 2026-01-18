import { describe, expect, it, vi } from "vitest";

import { createCliProgress } from "./progress.js";

describe("cli progress", () => {
  it("logs progress when non-tty and fallback=log", () => {
    const writes: string[] = [];
    const stream = {
      isTTY: false,
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
      }),
    } as unknown as NodeJS.WriteStream;

    const progress = createCliProgress({
      label: "Indexing memory...",
      total: 10,
      stream,
      fallback: "log",
    });
    progress.setPercent(50);
    progress.done();

    const output = writes.join("");
    expect(output).toContain("Indexing memory... 0%");
    expect(output).toContain("Indexing memory... 50%");
  });

  it("does not log without a tty when fallback is none", () => {
    const write = vi.fn();
    const stream = {
      isTTY: false,
      write,
    } as unknown as NodeJS.WriteStream;

    const progress = createCliProgress({
      label: "Nope",
      total: 2,
      stream,
      fallback: "none",
    });
    progress.setPercent(50);
    progress.done();

    expect(write).not.toHaveBeenCalled();
  });
});
