import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNextcloudTalkRoomKind, __testing } from "./room-info.js";

const fetchWithSsrFGuard = vi.hoisted(() => vi.fn());
const readFileSync = vi.hoisted(() => vi.fn());

vi.mock("../runtime-api.js", () => {
  return vi
    .importActual<typeof import("../runtime-api.js")>("../runtime-api.js")
    .then((actual) => ({
      ...actual,
      fetchWithSsrFGuard,
    }));
});

vi.mock("node:fs", () => {
  return vi.importActual<typeof import("node:fs")>("node:fs").then((actual) => ({
    ...actual,
    readFileSync,
  }));
});

afterEach(() => {
  fetchWithSsrFGuard.mockReset();
  readFileSync.mockReset();
  __testing.resetRoomCache();
});

function requireFirstFetchParams(): { auditContext?: string; url?: string } {
  const [call] = fetchWithSsrFGuard.mock.calls;
  if (!call) {
    throw new Error("expected Nextcloud Talk room info fetch call");
  }
  const [fetchParams] = call;
  if (!fetchParams || typeof fetchParams !== "object" || Array.isArray(fetchParams)) {
    throw new Error("expected Nextcloud Talk room info fetch call");
  }
  return fetchParams as { auditContext?: string; url?: string };
}

describe("nextcloud talk room info", () => {
  it("resolves direct rooms from the room info endpoint", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuard.mockResolvedValue({
      response: {
        ok: true,
        json: async () => ({
          ocs: {
            data: {
              type: 1,
            },
          },
        }),
      },
      release,
    });

    const kind = await resolveNextcloudTalkRoomKind({
      account: {
        accountId: "acct-direct",
        baseUrl: "https://nc.example.com",
        config: {
          apiUser: "bot",
          apiPassword: "secret",
        },
      } as never,
      roomToken: "room-direct",
    });

    expect(kind).toBe("direct");
    const fetchParams = requireFirstFetchParams();
    expect(fetchParams.url).toBe(
      "https://nc.example.com/ocs/v2.php/apps/spreed/api/v4/room/room-direct",
    );
    expect(fetchParams.auditContext).toBe("nextcloud-talk.room-info");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reads the api password from a file and logs non-ok room info responses", async () => {
    const release = vi.fn(async () => {});
    const log = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();
    readFileSync.mockReturnValue("file-secret\n");
    fetchWithSsrFGuard.mockResolvedValue({
      response: {
        ok: false,
        status: 403,
        json: async () => ({}),
      },
      release,
    });

    const kind = await resolveNextcloudTalkRoomKind({
      account: {
        accountId: "acct-group",
        baseUrl: "https://nc.example.com",
        config: {
          apiUser: "bot",
          apiPasswordFile: "/tmp/nextcloud-secret",
        },
      } as never,
      roomToken: "room-group",
      runtime: { log, error, exit },
    });

    expect(kind).toBeUndefined();
    expect(readFileSync).toHaveBeenCalledWith("/tmp/nextcloud-secret", "utf-8");
    expect(log).toHaveBeenCalledWith("nextcloud-talk: room lookup failed (403) token=room-group");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("returns undefined from room info without credentials or base url", async () => {
    await expect(
      resolveNextcloudTalkRoomKind({
        account: {
          accountId: "acct-missing",
          baseUrl: "",
          config: {},
        } as never,
        roomToken: "room-missing",
      }),
    ).resolves.toBeUndefined();

    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});
