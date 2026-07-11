// Nextcloud Talk tests cover room info plugin behavior.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNextcloudTalkRoomKind, testing } from "./room-info.js";

const fetchWithSsrFGuard = vi.hoisted(() => vi.fn());
const tempDirs: string[] = [];

vi.mock("../runtime-api.js", () => {
  return { fetchWithSsrFGuard };
});

afterEach(() => {
  fetchWithSsrFGuard.mockReset();
  testing.resetRoomCache();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

type RoomInfoFetchParams = {
  auditContext?: string;
  init?: { headers?: { Authorization?: string } };
  timeoutMs?: number;
  url?: string;
};

function requireFirstFetchParams(): RoomInfoFetchParams {
  const [call] = fetchWithSsrFGuard.mock.calls;
  if (!call) {
    throw new Error("expected Nextcloud Talk room info fetch call");
  }
  const [fetchParams] = call;
  if (!fetchParams || typeof fetchParams !== "object" || Array.isArray(fetchParams)) {
    throw new Error("expected Nextcloud Talk room info fetch call");
  }
  return fetchParams as RoomInfoFetchParams;
}

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("nextcloud talk room info", () => {
  it("resolves direct rooms from the room info endpoint", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuard.mockResolvedValue({
      response: jsonResponse({
        ocs: {
          data: {
            type: 1,
          },
        },
      }),
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
    expect(fetchParams.timeoutMs).toBe(30_000);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("caps cached room info entries", async () => {
    const cacheEntryLimit = 1000;
    fetchWithSsrFGuard.mockImplementation(async () => ({
      response: jsonResponse({
        ocs: {
          data: {
            type: 1,
          },
        },
      }),
      release: vi.fn(async () => {}),
    }));
    const account = {
      accountId: "acct-cache-cap",
      baseUrl: "https://nc.example.com",
      config: {
        apiUser: "bot",
        apiPassword: "secret",
      },
    } as never;

    for (let index = 0; index <= cacheEntryLimit; index += 1) {
      await resolveNextcloudTalkRoomKind({
        account,
        roomToken: `room-${index}`,
      });
    }
    await resolveNextcloudTalkRoomKind({ account, roomToken: "room-0" });
    const callsAfterOldestRetry = fetchWithSsrFGuard.mock.calls.length;
    await resolveNextcloudTalkRoomKind({
      account,
      roomToken: `room-${cacheEntryLimit}`,
    });

    expect(callsAfterOldestRetry).toBe(cacheEntryLimit + 2);
    expect(fetchWithSsrFGuard.mock.calls).toHaveLength(callsAfterOldestRetry);
    expect(fetchWithSsrFGuard.mock.calls.at(-1)?.[0]).toMatchObject({
      url: "https://nc.example.com/ocs/v2.php/apps/spreed/api/v4/room/room-0",
    });
  });

  it("normalizes signed decimal room type strings through the shared parser", async () => {
    fetchWithSsrFGuard.mockResolvedValue({
      response: jsonResponse({
        ocs: {
          data: {
            type: "+01",
          },
        },
      }),
      release: vi.fn(async () => {}),
    });

    await expect(
      resolveNextcloudTalkRoomKind({
        account: {
          accountId: "acct-direct-string",
          baseUrl: "https://nc.example.com",
          config: {
            apiUser: "bot",
            apiPassword: "secret",
          },
        } as never,
        roomToken: "room-direct-string",
      }),
    ).resolves.toBe("direct");
  });

  it("does not coerce partial room type strings", async () => {
    fetchWithSsrFGuard.mockResolvedValue({
      response: jsonResponse({
        ocs: {
          data: {
            type: "1direct",
          },
        },
      }),
      release: vi.fn(async () => {}),
    });

    await expect(
      resolveNextcloudTalkRoomKind({
        account: {
          accountId: "acct-partial",
          baseUrl: "https://nc.example.com",
          config: {
            apiUser: "bot",
            apiPassword: "secret",
          },
        } as never,
        roomToken: "room-partial",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not classify negative room types as group rooms", async () => {
    fetchWithSsrFGuard.mockResolvedValue({
      response: jsonResponse({
        ocs: {
          data: {
            type: -1,
          },
        },
      }),
      release: vi.fn(async () => {}),
    });

    await expect(
      resolveNextcloudTalkRoomKind({
        account: {
          accountId: "acct-negative",
          baseUrl: "https://nc.example.com",
          config: {
            apiUser: "bot",
            apiPassword: "secret",
          },
        } as never,
        roomToken: "room-negative",
      }),
    ).resolves.toBeUndefined();
  });

  it("reads the api password from a file and logs non-ok room info responses", async () => {
    const release = vi.fn(async () => {});
    const log = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();
    const tempDir = mkdtempSync(path.join(tmpdir(), "nextcloud-talk-room-info-"));
    tempDirs.push(tempDir);
    const passwordFile = path.join(tempDir, "secret");
    writeFileSync(passwordFile, "file-secret\n", "utf-8");
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
          apiPasswordFile: passwordFile,
        },
      } as never,
      roomToken: "room-group",
      runtime: { log, error, exit },
    });

    expect(kind).toBeUndefined();
    expect(requireFirstFetchParams().init?.headers?.Authorization).toBe(
      "Basic Ym90OmZpbGUtc2VjcmV0",
    );
    expect(log).toHaveBeenCalledWith("nextcloud-talk: room lookup failed (403) token=room-group");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reports malformed room info JSON with a stable channel error", async () => {
    const release = vi.fn(async () => {});
    const log = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();
    fetchWithSsrFGuard.mockResolvedValue({
      response: new Response("{ nope", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release,
    });

    const kind = await resolveNextcloudTalkRoomKind({
      account: {
        accountId: "acct-malformed",
        baseUrl: "https://nc.example.com",
        config: {
          apiUser: "bot",
          apiPassword: "secret",
        },
      } as never,
      roomToken: "room-malformed",
      runtime: { log, error, exit },
    });

    expect(kind).toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      "nextcloud-talk: room lookup error: Error: Nextcloud Talk room info failed: malformed JSON response",
    );
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
