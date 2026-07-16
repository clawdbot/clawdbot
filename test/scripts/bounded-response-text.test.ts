// E2E bounded response tests cover shared HTTP body limits.
import { describe, expect, it } from "vitest";
import {
  readBoundedResponseBytes,
  readBoundedResponseText,
} from "../../scripts/e2e/lib/bounded-response-text.mjs";

describe("scripts/e2e/lib/bounded-response-text.mjs", () => {
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

  it("cancels pending response body reads when the timeout wins", async () => {
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
    };

    await expect(
      readBoundedResponseText(
        response,
        "probe",
        1024,
        Promise.reject(new Error("probe timed out")),
      ),
    ).rejects.toThrow("probe timed out");

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
      { headers: new Headers() },
    );

    await expect(
      readBoundedResponseText(
        response,
        "probe",
        1024,
        Promise.reject(new Error("probe timed out")),
      ),
    ).rejects.toThrow("probe timed out");

    expect(canceled).toBe(true);
  });

  it("cancels oversized streamed response bodies", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(17));
        },
        cancel() {
          canceled = true;
        },
      }),
      { headers: new Headers() },
    );

    await expect(readBoundedResponseText(response, "probe", 16)).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "probe response body exceeded 16 bytes",
    });
    expect(canceled).toBe(true);
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
    };

    await expect(readBoundedResponseText(response, "probe", 16)).rejects.toMatchObject({
      code: "ETOOBIG",
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
    };

    await expect(readBoundedResponseText(response, "probe", 16)).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "probe response body exceeded 16 bytes",
    });
    expect(readStarted).toBe(false);
    expect(canceled).toBe(true);
  });
});
