// Bounded Response tests cover bounded response script behavior.
import { describe, expect, it } from "vitest";
import { readBoundedResponseText as readBoundedResponseTextMjs } from "../../scripts/lib/bounded-response.mjs";
import { readBoundedResponseText as readBoundedResponseTextTs } from "../../scripts/lib/bounded-response.ts";

const helpers = [
  ["ts", readBoundedResponseTextTs],
  ["mjs", readBoundedResponseTextMjs],
] as const;

describe("scripts bounded response reader", () => {
  it.each(helpers)("cancels response bodies when %s read timeout wins", async (_name, read) => {
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
            releaseLock() {},
          };
        },
      },
    } as unknown as Response;

    await expect(
      read(response, "probe", 1024, {
        timeoutPromise: new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("timeout")), 0);
        }),
      }),
    ).rejects.toThrow("timeout");

    expect(canceled).toBe(true);
  });

  it.each(helpers)(
    "rejects when %s timeout cancellation unblocks a real stream read",
    async (_name, read) => {
      let canceled = false;
      const response = {
        headers: new Headers(),
        body: new ReadableStream({
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            canceled = true;
          },
        }),
      } as unknown as Response;

      await expect(
        read(response, "probe", 1024, {
          timeoutPromise: new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error("timeout")), 0);
          }),
        }),
      ).rejects.toThrow("timeout");

      expect(canceled).toBe(true);
    },
  );

  it.each(helpers)(
    "streams %s responses with non-decimal content-length values",
    async (_name, read) => {
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

      await expect(read(response, "probe", 16)).rejects.toThrow(
        "probe response body exceeded 16 bytes",
      );

      expect(readStarted).toBe(true);
      expect(canceled).toBe(true);
    },
  );

  it.each(helpers)(
    "rejects unsafe decimal %s content-length values before reading",
    async (_name, read) => {
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

      await expect(read(response, "probe", 16)).rejects.toThrow(
        "probe response body exceeded 16 bytes",
      );

      expect(readStarted).toBe(false);
      expect(canceled).toBe(true);
    },
  );
});
