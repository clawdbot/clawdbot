// E2E bounded response text tests cover shared E2E HTTP body limits.
import { describe, expect, it } from "vitest";
import { readBoundedResponseText } from "../../scripts/e2e/lib/bounded-response-text.mjs";

describe("scripts/e2e/lib/bounded-response-text.mjs", () => {
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
});
