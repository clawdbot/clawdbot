import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { fstatSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { prepareSecretInputStdio, type SpawnStdioEntry } from "./spawn-secret-input.js";

class ControlledSecretStream extends EventEmitter {
  private endCallback: ((error?: Error | null) => void) | undefined;

  end(_data: Buffer, callback?: (error?: Error | null) => void): this {
    this.endCallback = callback;
    return this;
  }

  destroy(): this {
    return this;
  }

  finishWrite(error?: Error): void {
    if (!this.endCallback) {
      throw new Error("secret write callback was not registered");
    }
    this.endCallback(error);
  }
}

function childWithSecretStream(stream: ControlledSecretStream): ChildProcess {
  return { stdio: [null, null, null, stream] } as unknown as ChildProcess;
}

function writeSecret(stream: ControlledSecretStream): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  try {
    using prepared = prepareSecretInputStdio([], {
      fd: 3,
      createData: () => Buffer.from("selected-secret"),
    });
    return prepared!.deliverTo(childWithSecretStream(stream));
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("Windows secret input delivery", () => {
  it("consumes pipe errors after delivery until the stream closes", async () => {
    const stream = new ControlledSecretStream();
    const write = writeSecret(stream);

    stream.finishWrite();
    await expect(write).resolves.toBeUndefined();

    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(() => stream.emit("error", reset)).not.toThrow();
    expect(stream.listenerCount("error")).toBe(1);

    stream.emit("close");
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("rejects a blocked write when abortSignal fires", async () => {
    const stream = new ControlledSecretStream();
    const abort = new AbortController();
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      using prepared = prepareSecretInputStdio([], {
        fd: 3,
        createData: () => Buffer.from("selected-secret"),
      });
      const write = prepared!.deliverTo(childWithSecretStream(stream), {
        abortSignal: abort.signal,
      });
      abort.abort();
      await expect(write).rejects.toThrow("secret delivery aborted");
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  it("rejects delivery errors before consuming their later stream event", async () => {
    const stream = new ControlledSecretStream();
    const write = writeSecret(stream);
    const deliveryError = new Error("secret delivery failed");

    stream.finishWrite(deliveryError);
    await expect(write).rejects.toBe(deliveryError);
    expect(() => stream.emit("error", deliveryError)).not.toThrow();

    stream.emit("close");
    expect(stream.listenerCount("error")).toBe(0);
  });
});

function expectDescriptorReleased(fd: number, original: ReturnType<typeof fstatSync>) {
  let current: ReturnType<typeof fstatSync>;
  try {
    current = fstatSync(fd);
  } catch (error) {
    expect(error).toMatchObject({ code: "EBADF" });
    return;
  }
  // Other Vitest workers can reuse the number after close; identity owns the pipe.
  expect({ dev: current.dev, ino: current.ino }).not.toEqual({
    dev: original.dev,
    ino: original.ino,
  });
}

describe.skipIf(process.platform === "win32")("POSIX secret input ownership", () => {
  const descriptorPath = process.platform === "darwin" ? "/dev/fd/3" : "/proc/self/fd/3";

  it.each(["path", "direct"])(
    "delivers once through a %s reader without replay to descendants",
    async (reader) => {
      const stdio: SpawnStdioEntry[] = ["ignore", "pipe", "pipe"];
      const data = Buffer.from("private-fixture");
      using prepared = prepareSecretInputStdio(stdio, { fd: 3, createData: () => data });
      const original = fstatSync(stdio[3] as number);
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
      const fs = require("node:fs");
      const value = fs.readFileSync(${JSON.stringify(reader === "path" ? descriptorPath : 3)}, "utf8");
      const descendant = require("node:child_process").spawnSync(process.execPath,
        ["-e", 'process.stdout.write(String(require("node:fs").readFileSync(3).length))'],
        {stdio: ["ignore", "pipe", "inherit", 3]});
      process.stdout.write(JSON.stringify({value, descendant: descendant.stdout.toString()}));
    `,
        ],
        { stdio },
      );
      const output = new Promise<string>((resolve, reject) => {
        let text = "";
        child.stdout!.on("data", (chunk) => {
          text += chunk;
        });
        child.on("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve(text) : reject(new Error(`child exited ${code}`)),
        );
      });
      try {
        await prepared!.deliverTo(child);
        expect(JSON.parse(await output)).toEqual({ value: "private-fixture", descendant: "0" });
        expect(data.every((byte) => byte === 0)).toBe(true);
        expectDescriptorReleased(stdio[3] as number, original);
      } finally {
        child.kill("SIGKILL");
      }
    },
  );

  it("closes both untransferred ends when spawning throws", () => {
    const stdio: SpawnStdioEntry[] = ["ignore", "pipe", "pipe"];
    const createData = vi.fn(() => Buffer.from("not-delivered"));
    let original: ReturnType<typeof fstatSync>;
    expect(() => {
      using prepared = prepareSecretInputStdio(stdio, { fd: 3, createData });
      void prepared;
      original = fstatSync(stdio[3] as number);
      spawn("", [], { stdio });
    }).toThrow();
    expect(createData).not.toHaveBeenCalled();
    expectDescriptorReleased(stdio[3] as number, original!);
  });
  it("closes the writer without delivering bytes when credential creation throws", async () => {
    const stdio: SpawnStdioEntry[] = ["ignore", "pipe", "pipe"];
    const reason = new Error("credential unavailable");
    using prepared = prepareSecretInputStdio(stdio, {
      fd: 3,
      createData: () => {
        throw reason;
      },
    });
    const child = spawn(
      process.execPath,
      ["-e", 'process.stdout.write(String(require("node:fs").readFileSync(3).length))'],
      { stdio },
    );
    const output = new Promise<string>((resolve, reject) => {
      let text = "";
      child.stdout!.on("data", (chunk) => {
        text += chunk;
      });
      child.on("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve(text) : reject(new Error(`child exited ${code}`)),
      );
    });
    try {
      await expect(prepared!.deliverTo(child)).rejects.toBe(reason);
      await expect(output).resolves.toBe("0");
    } finally {
      child.kill("SIGKILL");
    }
  });
});
