import { describe, expect, it } from "vitest";
import { createSafeStreamWriter } from "./stream-writer.js";

describe("createSafeStreamWriter", () => {
  it("signals broken pipes and closes the writer", () => {
    let brokenPipeCount = 0;
    const writer = createSafeStreamWriter({
      onBrokenPipe: () => {
        brokenPipeCount += 1;
      },
    });
    const stream = {
      write: () => {
        const err = new Error("EPIPE") as NodeJS.ErrnoException;
        err.code = "EPIPE";
        throw err;
      },
    } as unknown as NodeJS.WriteStream;

    expect(writer.writeLine(stream, "hello")).toBe(false);
    expect(writer.isClosed()).toBe(true);
    expect(brokenPipeCount).toBe(1);

    brokenPipeCount = 0;
    expect(writer.writeLine(stream, "again")).toBe(false);
    expect(brokenPipeCount).toBe(0);
  });

  it("treats broken pipes from beforeWrite as closed", () => {
    let brokenPipeCount = 0;
    const writer = createSafeStreamWriter({
      onBrokenPipe: () => {
        brokenPipeCount += 1;
      },
      beforeWrite: () => {
        const err = new Error("EIO") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      },
    });
    const stream = {
      write: () => true,
    } as unknown as NodeJS.WriteStream;

    expect(writer.write(stream, "hi")).toBe(false);
    expect(writer.isClosed()).toBe(true);
    expect(brokenPipeCount).toBe(1);
  });
});
