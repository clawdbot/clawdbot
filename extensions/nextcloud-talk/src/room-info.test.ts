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

function requireFirstFetchParams(): {
  auditContext?: string;
  init?: { headers?: { Authorization?: string } };
  url?: string;
} {
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

  it("does not coerce partial room type strings", async () => {
    fetchWithSsrFGuard.mockResolvedValue({
      response: {
        ok: true,
        json: async () => ({
          ocs: {
            data: {
              type: "1direct",
            },
          },
        }),
      },
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
