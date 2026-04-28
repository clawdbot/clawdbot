import { describe, expect, it } from "vitest";
import { resolveGroupActivation, type SessionStoreReader } from "./activation.js";

describe("engine/group/activation", () => {
  describe("resolveGroupActivation — no reader", () => {
    it("maps configRequireMention=true → mention", () => {
      expect(
        resolveGroupActivation({
          cfg: {},
          agentId: "main",
          sessionKey: "s",
          configRequireMention: true,
        }),
      ).toBe("mention");
    });

    it("maps configRequireMention=false → always", () => {
      expect(
        resolveGroupActivation({
          cfg: {},
          agentId: "main",
          sessionKey: "s",
          configRequireMention: false,
        }),
      ).toBe("always");
    });
  });

  describe("resolveGroupActivation — with reader", () => {
    const makeReader = (
      store: Record<string, { groupActivation?: string }> | null,
    ): SessionStoreReader => ({
      read: () => store,
    });

    it("honours explicit session-store override (mention)", () => {
      const reader = makeReader({ k1: { groupActivation: "mention" } });
      expect(
        resolveGroupActivation({
          cfg: {},
          agentId: "main",
          sessionKey: "k1",
          configRequireMention: false,
          sessionStoreReader: reader,
        }),
      ).toBe("mention");
    });

    it("honours explicit session-store override (always)", () => {
      const reader = makeReader({ k1: { groupActivation: "always" } });
      expect(
        resolveGroupActivation({
          cfg: {},
          agentId: "main",
          sessionKey: "k1",
          configRequireMention: true,
          sessionStoreReader: reader,
        }),
      ).toBe("always");
    });

    it("ignores override when the key is absent", () => {
      const reader = makeReader({});
      expect(
        resolveGroupActivation({
          cfg: {},
          agentId: "main",
          sessionKey: "MISSING",
          configRequireMention: true,
          sessionStoreReader: reader,
        }),
      ).toBe("mention");
    });

    it("ignores reader errors (null) and falls back", () => {
      const reader = makeReader(null);
      expect(
        resolveGroupActivation({
          cfg: {},
          agentId: "main",
          sessionKey: "k1",
          configRequireMention: false,
          sessionStoreReader: reader,
        }),
      ).toBe("always");
    });

    it("ignores invalid activation values", () => {
      const reader = makeReader({ k1: { groupActivation: "weird-mode" } });
      expect(
        resolveGroupActivation({
          cfg: {},
          agentId: "main",
          sessionKey: "k1",
          configRequireMention: true,
          sessionStoreReader: reader,
        }),
      ).toBe("mention");
    });

    it("normalizes whitespace / case", () => {
      const reader = makeReader({ k1: { groupActivation: "  Always  " } });
      expect(
        resolveGroupActivation({
          cfg: {},
          agentId: "main",
          sessionKey: "k1",
          configRequireMention: true,
          sessionStoreReader: reader,
        }),
      ).toBe("always");
    });
  });
});
