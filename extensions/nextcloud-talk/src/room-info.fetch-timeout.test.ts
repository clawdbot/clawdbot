// Nextcloud Talk room info lookup tests cover real HTTP timeout behavior.
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { resolveNextcloudTalkRoomKind, testing } from "./room-info.js";

describe("nextcloud talk room info fetch timeout", () => {
  it("bounds hanging room info GET requests", async () => {
    let received = false;
    const runtimeError = vi.fn();

    try {
      await withServer(
        (request) => {
          received = true;
          expect(request.method).toBe("GET");
          expect(request.url).toBe("/ocs/v2.php/apps/spreed/api/v4/room/abc123");
          request.resume();
        },
        async (baseUrl) => {
          const kind = await resolveNextcloudTalkRoomKind({
            account: {
              accountId: "acct-hanging-room-info",
              baseUrl,
              config: {
                apiUser: "bot",
                apiPassword: "secret",
                network: { dangerouslyAllowPrivateNetwork: true },
              },
            } as never,
            roomToken: "abc123",
            runtime: {
              error: runtimeError,
              exit: vi.fn(),
              log: vi.fn(),
            },
            timeoutMs: 50,
          });

          expect(kind).toBeUndefined();
        },
      );
    } finally {
      testing.resetRoomCache();
    }

    expect(received).toBe(true);
    expect(String(runtimeError.mock.calls[0]?.[0] ?? "")).toMatch(/abort|timeout/i);
  });
});
