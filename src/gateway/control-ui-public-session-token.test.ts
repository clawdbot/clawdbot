import { afterEach, describe, expect, it } from "vitest";
import { loadDeviceIdentityIfPresent } from "../infra/device-identity.js";
import { isSecretValueRegisteredForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  loadPublicSessionShareTokenCodec,
  resolvePublicSessionShareToken,
  type PublicSessionShareLocator,
} from "./control-ui-public-session-token.js";

const LOCATOR: PublicSessionShareLocator = {
  agentId: "opaque-agent-identifier",
  sessionKey: "agent:opaque-agent-identifier:discord:channel:private-team-identifier",
  sessionId: "opaque-séssion-identifier.123",
  shareId: "a".repeat(48),
};

afterEach(() => resetSecretRedactionRegistryForTest());

describe("public session share token", () => {
  it("round-trips an exact locator without exposing any identifier", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const codec = loadPublicSessionShareTokenCodec();
      const token = codec.mint(LOCATOR);
      expect(codec.resolve(token)).toEqual(LOCATOR);
      for (const identifier of Object.values(LOCATOR)) {
        expect(token).not.toContain(identifier);
      }
      expect(isSecretValueRegisteredForRedaction(token)).toBe(true);
      expect(isSecretValueRegisteredForRedaction(LOCATOR.shareId)).toBe(true);
    });
  });

  it("uses fresh nonces while retaining the same restart-stable identity", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const first = loadPublicSessionShareTokenCodec();
      const firstToken = first.mint(LOCATOR);
      const secondToken = first.mint(LOCATOR);
      const second = loadPublicSessionShareTokenCodec();
      expect(secondToken).not.toBe(firstToken);
      expect(second.resolve(firstToken)).toEqual(LOCATOR);
      expect(second.resolve(secondToken)).toEqual(LOCATOR);
    });
  });

  it("fails closed for tampering, another installation, and malformed tokens", async () => {
    const token = await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const codec = loadPublicSessionShareTokenCodec();
      const created = codec.mint(LOCATOR);
      const last = created.at(-1) ?? "";
      const tampered = `${created.slice(0, -1)}${last === "a" ? "b" : "a"}`;
      expect(codec.resolve(tampered)).toBeNull();
      expect(codec.resolve("v1.invalid+base64")).toBeNull();
      expect(codec.resolve(`v2.${created.slice(3)}`)).toBeNull();
      return created;
    });
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      expect(resolvePublicSessionShareToken(token)).toBeNull();
    });
  });

  it("does not create durable identity state from an anonymous token", async () => {
    const foreignToken = await withOpenClawTestState({ scenario: "minimal" }, async () =>
      loadPublicSessionShareTokenCodec().mint(LOCATOR),
    );
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      expect(resolvePublicSessionShareToken(foreignToken)).toBeNull();
      expect(loadDeviceIdentityIfPresent()).toBeNull();

      const localToken = loadPublicSessionShareTokenCodec().mint(LOCATOR);
      expect(loadDeviceIdentityIfPresent()).not.toBeNull();
      expect(resolvePublicSessionShareToken(localToken)).toEqual(LOCATOR);
    });
  });
});
