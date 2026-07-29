// Nextcloud Talk tests cover core plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  looksLikeNextcloudTalkTargetId,
  normalizeNextcloudTalkMessagingTarget,
  stripNextcloudTalkTargetPrefix,
} from "./normalize.js";
import { resolveNextcloudTalkAllowlistMatch } from "./policy.js";
import { resolveNextcloudTalkOutboundSessionRoute } from "./session-route.js";
import {
  extractNextcloudTalkHeaders,
  generateNextcloudTalkSignature,
  verifyNextcloudTalkSignature,
} from "./signature.js";

function requireFirstTimingSafeEqualCall(mock: ReturnType<typeof vi.fn>): [unknown, unknown] {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected timingSafeEqual call");
  }
  return call as [unknown, unknown];
}

describe("nextcloud talk core", () => {
  it("marks ambiguous room-token session routes as best-effort", () => {
    const route = resolveNextcloudTalkOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "nextcloud-talk:room-123",
    });

    expect(route).toEqual({
      sessionKey: "agent:main:nextcloud-talk:group:room-123",
      baseSessionKey: "agent:main:nextcloud-talk:group:room-123",
      recipientSessionExact: false,
      peer: {
        kind: "group",
        id: "room-123",
      },
      chatType: "group",
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
    expect(stripNextcloudTalkTargetPrefix("NC-TALK:ROOM:Ops")).toBe("Ops");
    expect(stripNextcloudTalkTargetPrefix("room:   ")).toBeUndefined();

    expect(normalizeNextcloudTalkMessagingTarget("room:AbC123")).toBe("nextcloud-talk:abc123");
    expect(normalizeNextcloudTalkMessagingTarget("nc-talk:room:Ops")).toBe("nextcloud-talk:ops");
    expect(normalizeNextcloudTalkMessagingTarget("NEXTCLOUD-TALK:ROOM:Ops")).toBe(
      "nextcloud-talk:ops",
    );

    expect(looksLikeNextcloudTalkTargetId("nextcloud-talk:room:abc12345")).toBe(true);
    expect(looksLikeNextcloudTalkTargetId("nc:opsroom1")).toBe(true);
    expect(looksLikeNextcloudTalkTargetId("room:opsroom1")).toBe(true);
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
      const {
        generateNextcloudTalkSignature: generateNextcloudTalkSignatureLocal,
        verifyNextcloudTalkSignature: verifyNextcloudTalkSignatureLocal,
      } = await import("./signature.js");
      const body = JSON.stringify({ hello: "world" });
      const generated = generateNextcloudTalkSignatureLocal({
        body,
        secret: "secret-123",
      });
      const shortSignature = generated.signature.slice(0, 12);

      expect(
        verifyNextcloudTalkSignatureLocal({
          signature: shortSignature,
          random: generated.random,
          body,
          secret: "secret-123",
        }),
      ).toBe(false);

      expect(timingSafeEqualMock).toHaveBeenCalledOnce();
      const [leftBuffer, rightBuffer] = requireFirstTimingSafeEqualCall(timingSafeEqualMock);
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

  it("resolves allowlist matches", () => {
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
  });
});
