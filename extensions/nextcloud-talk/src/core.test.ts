import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  looksLikeNextcloudTalkTargetId,
  normalizeNextcloudTalkMessagingTarget,
  stripNextcloudTalkTargetPrefix,
} from "./normalize.js";
import { resolveNextcloudTalkAllowlistMatch, resolveNextcloudTalkGroupAllow } from "./policy.js";
import { createNextcloudTalkReplayGuard } from "./replay-guard.js";
import { resolveNextcloudTalkOutboundSessionRoute } from "./session-route.js";
import {
  extractNextcloudTalkHeaders,
  generateNextcloudTalkSignature,
  verifyNextcloudTalkSignature,
} from "./signature.js";

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

const tempDirs: string[] = [];
let resolveNextcloudTalkRoomKind: typeof import("./room-info.js").resolveNextcloudTalkRoomKind;
let resetNextcloudTalkRoomCache: () => void;

beforeAll(async () => {
  const roomInfo = await import("./room-info.js");
  resolveNextcloudTalkRoomKind = roomInfo.resolveNextcloudTalkRoomKind;
  resetNextcloudTalkRoomCache = roomInfo.__testing.resetRoomCache;
});

afterEach(async () => {
  fetchWithSsrFGuard.mockReset();
  readFileSync.mockReset();
  resetNextcloudTalkRoomCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nextcloud-talk-replay-"));
  tempDirs.push(dir);
  return dir;
}

describe("nextcloud talk core", () => {
  it("builds an outbound session route for normalized room targets", () => {
    const route = resolveNextcloudTalkOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "nextcloud-talk:room-123",
    });

    expect(route).toMatchObject({
      peer: {
        kind: "group",
        id: "room-123",
      },
      from: "nextcloud-talk:room:room-123",
      to: "nextcloud-talk:room-123",
    });
  });

  it("returns null when the target cannot be normalized to a room id", () => {
    expect(
      resolveNextcloudTalkOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        accountId: "acct-1",
        target: "",
      }),
    ).toBeNull();
  });

  it("normalizes and recognizes supported room target formats", () => {
    expect(stripNextcloudTalkTargetPrefix(" room:abc123 ")).toBe("abc123");
    expect(stripNextcloudTalkTargetPrefix("nextcloud-talk:room:AbC123")).toBe("AbC123");
    expect(stripNextcloudTalkTargetPrefix("nc-talk:room:ops")).toBe("ops");
    expect(stripNextcloudTalkTargetPrefix("nc:room:ops")).toBe("ops");
    expect(stripNextcloudTalkTargetPrefix("room:   ")).toBeUndefined();

    expect(normalizeNextcloudTalkMessagingTarget("room:AbC123")).toBe("nextcloud-talk:abc123");
    expect(normalizeNextcloudTalkMessagingTarget("nc-talk:room:Ops")).toBe("nextcloud-talk:ops");

    expect(looksLikeNextcloudTalkTargetId("nextcloud-talk:room:abc12345")).toBe(true);
    expect(looksLikeNextcloudTalkTargetId("nc:opsroom1")).toBe(true);
    expect(looksLikeNextcloudTalkTargetId("abc12345")).toBe(true);
    expect(looksLikeNextcloudTalkTargetId("")).toBe(false);
  });

  it("verifies generated signatures and extracts normalized headers", () => {
    const body = JSON.stringify({ hello: "world" });
    const generated = generateNextcloudTalkSignature({
      body,
      secret: "secret-123",
    });

    expect(generated.random).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(
      verifyNextcloudTalkSignature({
        signature: generated.signature,
        random: generated.random,
        body,
        secret: "secret-123",
      }),
    ).toBe(true);
    expect(
      verifyNextcloudTalkSignature({
        signature: "",
        random: "abc",
        body: "body",
        secret: "secret",
      }),
    ).toBe(false);
    expect(
      verifyNextcloudTalkSignature({
        signature: "deadbeef",
        random: "abc",
        body: "body",
        secret: "secret",
      }),
    ).toBe(false);

    expect(
      extractNextcloudTalkHeaders({
        "x-nextcloud-talk-signature": "sig",
        "x-nextcloud-talk-random": "rand",
        "x-nextcloud-talk-backend": "backend",
      }),
    ).toEqual({
      signature: "sig",
      random: "rand",
      backend: "backend",
    });
    expect(
      extractNextcloudTalkHeaders({
        "X-Nextcloud-Talk-Signature": "sig",
      }),
    ).toBeNull();
  });

  it("persists replay decisions across guard instances", async () => {
    const stateDir = await makeTempDir();

    const firstGuard = createNextcloudTalkReplayGuard({ stateDir });
    const firstAttempt = await firstGuard.shouldProcessMessage({
      accountId: "account-a",
      roomToken: "room-1",
      messageId: "msg-1",
    });
    const replayAttempt = await firstGuard.shouldProcessMessage({
      accountId: "account-a",
      roomToken: "room-1",
      messageId: "msg-1",
    });

    const secondGuard = createNextcloudTalkReplayGuard({ stateDir });
    const restartReplayAttempt = await secondGuard.shouldProcessMessage({
      accountId: "account-a",
      roomToken: "room-1",
      messageId: "msg-1",
    });

    expect(firstAttempt).toBe(true);
    expect(replayAttempt).toBe(false);
    expect(restartReplayAttempt).toBe(false);
  });

  it("scopes replay state by account namespace", async () => {
    const stateDir = await makeTempDir();
    const guard = createNextcloudTalkReplayGuard({ stateDir });

    const accountAFirst = await guard.shouldProcessMessage({
      accountId: "account-a",
      roomToken: "room-1",
      messageId: "msg-9",
    });
    const accountBFirst = await guard.shouldProcessMessage({
      accountId: "account-b",
      roomToken: "room-1",
      messageId: "msg-9",
    });

    expect(accountAFirst).toBe(true);
    expect(accountBFirst).toBe(true);
  });

  it("releases in-flight replay claims when processing fails", async () => {
    const stateDir = await makeTempDir();
    const guard = createNextcloudTalkReplayGuard({ stateDir });

    const firstClaim = await guard.claimMessage({
      accountId: "account-a",
      roomToken: "room-1",
      messageId: "msg-claim",
    });
    const secondClaim = await guard.claimMessage({
      accountId: "account-a",
      roomToken: "room-1",
      messageId: "msg-claim",
    });

    expect(firstClaim).toBe("claimed");
    expect(secondClaim).toBe("inflight");

    guard.releaseMessage({
      accountId: "account-a",
      roomToken: "room-1",
      messageId: "msg-claim",
      error: new Error("transient"),
    });

    const retryClaim = await guard.claimMessage({
      accountId: "account-a",
      roomToken: "room-1",
      messageId: "msg-claim",
    });
    expect(retryClaim).toBe("claimed");
  });

  it("resolves allowlist matches and group policy decisions", () => {
    expect(
      resolveNextcloudTalkAllowlistMatch({
        allowFrom: ["*"],
        senderId: "user-id",
      }).allowed,
    ).toBe(true);
    expect(
      resolveNextcloudTalkAllowlistMatch({
        allowFrom: ["nc:User-Id"],
        senderId: "user-id",
      }),
    ).toEqual({ allowed: true, matchKey: "user-id", matchSource: "id" });
    expect(
      resolveNextcloudTalkAllowlistMatch({
        allowFrom: ["allowed"],
        senderId: "other",
      }).allowed,
    ).toBe(false);

    expect(
      resolveNextcloudTalkGroupAllow({
        groupPolicy: "disabled",
        outerAllowFrom: ["owner"],
        innerAllowFrom: ["room-user"],
        senderId: "owner",
      }),
    ).toEqual({
      allowed: false,
      outerMatch: { allowed: false },
      innerMatch: { allowed: false },
    });
    expect(
      resolveNextcloudTalkGroupAllow({
        groupPolicy: "open",
        outerAllowFrom: [],
        innerAllowFrom: [],
        senderId: "owner",
      }),
    ).toEqual({
      allowed: true,
      outerMatch: { allowed: true },
      innerMatch: { allowed: true },
    });
    expect(
      resolveNextcloudTalkGroupAllow({
        groupPolicy: "allowlist",
        outerAllowFrom: [],
        innerAllowFrom: [],
        senderId: "owner",
      }),
    ).toEqual({
      allowed: false,
      outerMatch: { allowed: false },
      innerMatch: { allowed: false },
    });
    expect(
      resolveNextcloudTalkGroupAllow({
        groupPolicy: "allowlist",
        outerAllowFrom: [],
        innerAllowFrom: ["room-user"],
        senderId: "room-user",
      }),
    ).toEqual({
      allowed: true,
      outerMatch: { allowed: false },
      innerMatch: { allowed: true, matchKey: "room-user", matchSource: "id" },
    });
    expect(
      resolveNextcloudTalkGroupAllow({
        groupPolicy: "allowlist",
        outerAllowFrom: ["team-owner"],
        innerAllowFrom: ["room-user"],
        senderId: "room-user",
      }),
    ).toEqual({
      allowed: false,
      outerMatch: { allowed: false },
      innerMatch: { allowed: true, matchKey: "room-user", matchSource: "id" },
    });
    expect(
      resolveNextcloudTalkGroupAllow({
        groupPolicy: "allowlist",
        outerAllowFrom: ["team-owner"],
        innerAllowFrom: ["room-user"],
        senderId: "team-owner",
      }),
    ).toEqual({
      allowed: false,
      outerMatch: { allowed: true, matchKey: "team-owner", matchSource: "id" },
      innerMatch: { allowed: false },
    });
    expect(
      resolveNextcloudTalkGroupAllow({
        groupPolicy: "allowlist",
        outerAllowFrom: ["shared-user"],
        innerAllowFrom: ["shared-user"],
        senderId: "shared-user",
      }),
    ).toEqual({
      allowed: true,
      outerMatch: { allowed: true, matchKey: "shared-user", matchSource: "id" },
      innerMatch: { allowed: true, matchKey: "shared-user", matchSource: "id" },
    });
  });

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
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://nc.example.com/ocs/v2.php/apps/spreed/api/v4/room/room-direct",
        auditContext: "nextcloud-talk.room-info",
      }),
    );
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
