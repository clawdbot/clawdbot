import { describe, expect, it } from "vitest";
import { createSafeStreamWriter } from "./stream-writer.js";

function createSpy<Args extends unknown[], ReturnValue>(
  implementation?: (...args: Args) => ReturnValue,
) {
  const calls: Args[] = [];
  const spy = (...args: Args) => {
    calls.push(args);
    return implementation?.(...args) as ReturnValue;
  };
  spy.calls = calls;
  spy.clear = () => {
    calls.length = 0;
  };
  return spy;
}

describe("createSafeStreamWriter", () => {
  it("signals broken pipes and closes the writer", () => {
    const onBrokenPipe = createSpy<[], void>();
    const writer = createSafeStreamWriter({ onBrokenPipe });
    const stream = {
      write: createSpy<[string], boolean>(() => {
        const err = new Error("EPIPE") as NodeJS.ErrnoException;
        err.code = "EPIPE";
        throw err;
      }),
    } as unknown as NodeJS.WriteStream;

    expect(writer.writeLine(stream, "hello")).toBe(false);
    expect(writer.isClosed()).toBe(true);
    expect(onBrokenPipe.calls).toHaveLength(1);

    onBrokenPipe.clear();
    expect(writer.writeLine(stream, "again")).toBe(false);
    expect(onBrokenPipe.calls).toHaveLength(0);
  });

  it("treats broken pipes from beforeWrite as closed", () => {
    const onBrokenPipe = createSpy<[], void>();
    const writer = createSafeStreamWriter({
      onBrokenPipe,
      beforeWrite: () => {
        const err = new Error("EIO") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      },
    });
    const stream = {
      write: createSpy<[string], boolean>(() => true),
    } as unknown as NodeJS.WriteStream;

    expect(writer.write(stream, "hi")).toBe(false);
    expect(writer.isClosed()).toBe(true);
    expect(onBrokenPipe.calls).toHaveLength(1);
  });
});
