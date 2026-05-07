import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const tempDirs: string[] = [];

afterEach(async () => {
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

  it("rejects tampered bodies, wrong secrets, and tampered signatures", () => {
    const body = JSON.stringify({ hello: "world" });
    const generated = generateNextcloudTalkSignature({
      body,
      secret: "secret-123",
    });

    expect(
      verifyNextcloudTalkSignature({
        signature: generated.signature,
        random: generated.random,
        body: JSON.stringify({ hello: "tampered" }),
        secret: "secret-123",
      }),
    ).toBe(false);
    expect(
      verifyNextcloudTalkSignature({
        signature: generated.signature,
        random: generated.random,
        body,
        secret: "wrong-secret",
      }),
    ).toBe(false);
    expect(
      verifyNextcloudTalkSignature({
        signature: "a".repeat(generated.signature.length),
        random: generated.random,
        body,
        secret: "secret-123",
      }),
    ).toBe(false);
  });

  it("takes the first value from array-backed headers", () => {
    expect(
      extractNextcloudTalkHeaders({
        "x-nextcloud-talk-signature": ["sig1", "sig2"],
        "x-nextcloud-talk-random": ["rand1", "rand2"],
        "x-nextcloud-talk-backend": ["backend1", "backend2"],
      }),
    ).toEqual({
      signature: "sig1",
      random: "rand1",
      backend: "backend1",
    });
  });

  it("still runs timingSafeEqual when the supplied signature length mismatches", async () => {
    const timingSafeEqualMock = vi.fn();

    vi.resetModules();
    vi.doMock("node:crypto", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:crypto")>();
      return {
        ...actual,
        timingSafeEqual: vi.fn((left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView) => {
          timingSafeEqualMock(left, right);
          return actual.timingSafeEqual(left, right);
        }),
      };
    });

    try {
      const { generateNextcloudTalkSignature, verifyNextcloudTalkSignature } =
        await import("./signature.js");
      const body = JSON.stringify({ hello: "world" });
      const generated = generateNextcloudTalkSignature({
        body,
        secret: "secret-123",
      });
      const shortSignature = generated.signature.slice(0, 12);

      expect(
        verifyNextcloudTalkSignature({
          signature: shortSignature,
          random: generated.random,
          body,
          secret: "secret-123",
        }),
      ).toBe(false);

      expect(timingSafeEqualMock).toHaveBeenCalledOnce();
      const [leftBuffer, rightBuffer] = timingSafeEqualMock.mock.calls[0] ?? [];
      expect(Buffer.isBuffer(leftBuffer)).toBe(true);
      expect(Buffer.isBuffer(rightBuffer)).toBe(true);
      if (!Buffer.isBuffer(leftBuffer) || !Buffer.isBuffer(rightBuffer)) {
        throw new TypeError("Expected timingSafeEqual to receive Buffer arguments");
      }
      expect(leftBuffer).toHaveLength(rightBuffer.length);
    } finally {
      vi.doUnmock("node:crypto");
      vi.resetModules();
    }
  });

  it("persists replay decisions across guard instances and scopes account namespaces", async () => {
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
    const otherAccountFirstAttempt = await secondGuard.shouldProcessMessage({
      accountId: "account-b",
      roomToken: "room-1",
      messageId: "msg-1",
    });

    expect(firstAttempt).toBe(true);
    expect(replayAttempt).toBe(false);
    expect(restartReplayAttempt).toBe(false);
    expect(otherAccountFirstAttempt).toBe(true);
  });

  it("releases in-flight replay claims when processing fails", async () => {
    const guard = createNextcloudTalkReplayGuard({});

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
});
