import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { writeSecretInputToChild } from "./spawn-secret-input.js";

class ControlledSecretStream extends EventEmitter {
  private endCallback: ((error?: Error | null) => void) | undefined;

  end(_data: Buffer, callback?: (error?: Error | null) => void): this {
    this.endCallback = callback;
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
  return writeSecretInputToChild(childWithSecretStream(stream), {
    fd: 3,
    createData: () => Buffer.from("selected-secret"),
  });
}

describe("writeSecretInputToChild", () => {
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
