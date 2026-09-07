import {
  fetchWithSsrFGuard,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { releaseNextcloudTalkGuardedResponse } from "./guarded-response.js";

describe("releaseNextcloudTalkGuardedResponse", () => {
  it("starts cancel of an unread body before releasing the guard", async () => {
    const events: string[] = [];
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          events.push("cancel");
        },
      }),
    );

    await releaseNextcloudTalkGuardedResponse({
      response,
      release: async () => {
        events.push("release");
      },
    });

    expect(events).toEqual(["cancel", "release"]);
  });

  it("releases without waiting when body cancel never settles", async () => {
    let cancelStarted = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelStarted = true;
          // Debug capture tees leave one branch reading; cancel on the other
          // branch never settles until both cancel — awaiting hangs release.
          return new Promise(() => {});
        },
      }),
    );
    const release = vi.fn(async () => {});

    const startedAt = Date.now();
    await expect(
      Promise.race([
        releaseNextcloudTalkGuardedResponse({ response, release }),
        new Promise<never>((_, reject) => {
          AbortSignal.timeout(1_000).addEventListener("abort", () => {
            reject(new Error("release hung waiting for body.cancel"));
          });
        }),
      ]),
    ).resolves.toBeUndefined();
    const elapsedMs = Date.now() - startedAt;

    expect(cancelStarted).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("releases a real guarded fetch without waiting for a hanging response body", async () => {
    let received = false;
    let closed = false;
    await withServer(
      (request, response) => {
        received = true;
        request.on("close", () => {
          closed = true;
        });
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
        });
        response.write('{"ocs":');
      },
      async (baseUrl) => {
        const guarded = await fetchWithSsrFGuard({
          url: `${baseUrl}/ocs/v2.php/apps/spreed/api/v4/room/hang`,
          init: { method: "GET" },
          auditContext: "nextcloud-talk.release-cancel",
          policy: ssrfPolicyFromDangerouslyAllowPrivateNetwork(true),
        });
        const startedAt = Date.now();
        await releaseNextcloudTalkGuardedResponse({
          response: guarded.response,
          release: guarded.release,
        });
        expect(Date.now() - startedAt).toBeLessThan(1_000);
      },
    );
    expect(received).toBe(true);
    expect(closed).toBe(true);
  });

  it("still releases when body cancellation fails", async () => {
    const response = new Response(new ReadableStream<Uint8Array>());
    vi.spyOn(response.body!, "cancel").mockRejectedValueOnce(new Error("cancel failed"));
    const release = vi.fn(async () => {});

    await expect(
      releaseNextcloudTalkGuardedResponse({ response, release }),
    ).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not cancel a body the caller already consumed", async () => {
    const response = new Response("done");
    const cancel = vi.spyOn(response.body!, "cancel");
    await response.text();
    const release = vi.fn(async () => {});

    await releaseNextcloudTalkGuardedResponse({ response, release });

    expect(cancel).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});
