import { describe, expect, it, vi } from "vitest";
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

  it("notifies once when a reentrant write closes before the outer write", () => {
    const failure = Object.assign(new Error("closed pipe"), { code: "EPIPE" });
    let entered = false;
    let nestedResult: boolean | undefined;
    let callbackResult: boolean | undefined;
    let notifications = 0;
    const writer = createSafeStreamWriter({
      beforeWrite: () => {
        if (!entered) {
          entered = true;
          nestedResult = writer.write(process.stdout, "nested");
        }
      },
      onBrokenPipe: () => {
        notifications += 1;
        callbackResult = writer.write(process.stdout, "callback");
      },
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw failure;
    });
    try {
      expect(writer.write(process.stdout, "outer")).toBe(false);
      expect(nestedResult).toBe(false);
      expect(callbackResult).toBe(false);
      expect(writer.isClosed()).toBe(true);
      expect(notifications).toBe(1);
      expect(write.mock.calls.map(([text]) => text)).toEqual(["nested", "outer"]);
    } finally {
      write.mockRestore();
    }
  });

  it("keeps a callback reset effective through a reentrant successful write", () => {
    const failure = Object.assign(new Error("closed pipe"), { code: "EPIPE" });
    let notifications = 0;
    let recoveredResult: boolean | undefined;
    const writer = createSafeStreamWriter({
      onBrokenPipe: () => {
        notifications += 1;
        if (notifications === 1) {
          writer.reset();
          recoveredResult = writer.write(process.stdout, "recovered");
        }
      },
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation((text) => {
      if (text === "recovered") {
        return true;
      }
      throw failure;
    });
    try {
      expect(writer.write(process.stdout, "first")).toBe(false);
      expect(recoveredResult).toBe(true);
      expect(writer.isClosed()).toBe(false);
      expect(writer.write(process.stdout, "retry")).toBe(false);
      expect(writer.isClosed()).toBe(true);
      expect(notifications).toBe(2);
      expect(write.mock.calls.map(([text]) => text)).toEqual(["first", "recovered", "retry"]);
    } finally {
      write.mockRestore();
    }
  });

  it("keeps the output closed when the notification callback throws", () => {
    const failure = Object.assign(new Error("closed pipe"), { code: "EPIPE" });
    const callbackError = new Error("notification failed");
    const writer = createSafeStreamWriter({
      onBrokenPipe: () => {
        throw callbackError;
      },
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw failure;
    });
    try {
      let thrown: unknown;
      try {
        writer.write(process.stdout, "first");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(callbackError);
      expect(writer.isClosed()).toBe(true);
      expect(writer.write(process.stdout, "ignored")).toBe(false);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
    }
  });
});
