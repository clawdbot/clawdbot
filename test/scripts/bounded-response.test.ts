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

  it.each([
    { label: "identical", second: "17", combined: "17, 17", readsBody: false },
    { label: "equivalent", second: "017", combined: "17, 017", readsBody: false },
    { label: "conflicting", second: "12", combined: "17, 12", readsBody: true },
    { label: "malformed", second: "1e3", combined: "17, 1e3", readsBody: true },
    { label: "empty", second: "", combined: "17, ", readsBody: true },
  ])("handles $label repeated content-length values", async ({ second, combined, readsBody }) => {
    const headers = new Headers();
    headers.append("content-length", "17");
    headers.append("content-length", second);
    expect(headers.get("content-length")).toBe(combined);

    let readStarted = false;
    let canceled = false;
    const response = {
      headers,
      body: {
        async cancel() {
          canceled = true;
        },
        getReader() {
          return {
            async read() {
              readStarted = true;
              return readsBody
                ? { done: false, value: new Uint8Array(17) }
                : new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
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
    expect(readStarted).toBe(readsBody);
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
