// Bounded Response tests cover bounded response script behavior.
import { describe, expect, it } from "vitest";
import {
  createBoundedResponseTooLargeError,
  readBoundedResponseBytes,
  readBoundedResponseText,
} from "../../scripts/lib/bounded-response.mjs";

describe("scripts bounded response reader", () => {
  it("preserves binary response bytes", async () => {
    const body = Buffer.from([0x00, 0xff, 0x80, 0x7f]);

    await expect(
      readBoundedResponseBytes(new Response(body), "fixture", body.length),
    ).resolves.toEqual(body);
  });

  it("decodes multibyte text split across chunks", async () => {
    const encoded = new TextEncoder().encode("a😀b");
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoded.subarray(0, 3));
          controller.enqueue(encoded.subarray(3));
          controller.close();
        },
      }),
    );

    await expect(readBoundedResponseText(response, "fixture", encoded.length)).resolves.toBe(
      "a😀b",
    );
  });

  it("cancels response bodies when a read timeout wins", async () => {
    let canceled = false;
    const response = {
      headers: new Headers(),
      body: {
        getReader() {
          return {
            read() {
              return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
            },
            async cancel() {
              canceled = true;
            },
            releaseLock() {
              throw new Error("releaseLock should not run while a read is pending");
            },
          };
        },
      },
    } as unknown as Response;

    await expect(
      readBoundedResponseText(response, "probe", 1024, {
        timeoutPromise: Promise.reject(new Error("timeout")),
      }),
    ).rejects.toThrow("timeout");
    expect(canceled).toBe(true);
  });

  it("keeps timeout rejection ahead of cancel-unblocked stream reads", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          canceled = true;
        },
      }),
    );

    await expect(
      readBoundedResponseText(response, "probe", 1024, {
        timeoutPromise: Promise.reject(new Error("timeout")),
      }),
    ).rejects.toThrow("timeout");
    expect(canceled).toBe(true);
  });

  it("preserves opt-in ETOOBIG errors for E2E callers", async () => {
    await expect(
      readBoundedResponseText(new Response(new Uint8Array(17)), "probe", 16, {
        createTooLargeError: createBoundedResponseTooLargeError,
      }),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "probe response body exceeded 16 bytes",
    });
  });

  it("streams responses with non-decimal content-length values", async () => {
    let readStarted = false;
    let canceled = false;
    const response = {
      headers: new Headers({ "content-length": "1e3" }),
      body: {
        getReader() {
          return {
            async read() {
              readStarted = true;
              return { done: false, value: new Uint8Array(17) };
            },
            async cancel() {
              canceled = true;
            },
            releaseLock() {},
          };
        },
      },
    } as unknown as Response;

    await expect(readBoundedResponseText(response, "probe", 16)).rejects.toMatchObject({
      message: "probe response body exceeded 16 bytes",
    });
    expect(readStarted).toBe(true);
    expect(canceled).toBe(true);
  });

  it("rejects unsafe decimal content-length values before reading", async () => {
    let readStarted = false;
    let canceled = false;
    const response = {
      headers: new Headers({ "content-length": "9007199254740993" }),
      body: {
        async cancel() {
          canceled = true;
        },
        getReader() {
          return {
            async read() {
              readStarted = true;
              return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
            },
            async cancel() {
              canceled = true;
            },
            releaseLock() {},
          };
        },
      },
    } as unknown as Response;

    await expect(readBoundedResponseText(response, "probe", 16)).rejects.toThrow(
      "probe response body exceeded 16 bytes",
    );
    expect(readStarted).toBe(false);
    expect(canceled).toBe(true);
  });
});
