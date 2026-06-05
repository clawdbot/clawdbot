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
});
