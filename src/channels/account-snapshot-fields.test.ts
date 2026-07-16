// Account snapshot field tests cover channel account snapshot serialization fields.
import { describe, expect, it } from "vitest";
import {
  projectSafeChannelAccountSnapshotFields,
  redactChannelAccountSnapshotBaseUrl,
} from "./account-snapshot-fields.js";

function joinUrlParts(...parts: string[]): string {
  return parts.join("");
}

describe("projectSafeChannelAccountSnapshotFields", () => {
  it("omits webhook and public-key style fields from generic snapshots", () => {
    const snapshot = projectSafeChannelAccountSnapshotFields({
      name: "Primary",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
      signingSecretSource: "config", // pragma: allowlist secret
      signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
      webhookUrl: "https://example.com/webhook",
      webhookPath: "/webhook",
      audienceType: "project-number",
      audience: "1234567890",
      publicKey: "pk_live_123",
    });

    expect(snapshot).toEqual({
      name: "Primary",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
      signingSecretSource: "config", // pragma: allowlist secret
      signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
    });
  });

  it("strips embedded credentials from baseUrl fields", () => {
    const snapshot = projectSafeChannelAccountSnapshotFields({
      baseUrl: "https://bob:secret@chat.example.test",
    });

    expect(snapshot).toEqual({
      baseUrl: "https://chat.example.test/",
    });
  });

  it("redacts query, nested URL, and fragment credentials from baseUrl fields", () => {
    const nested = encodeURIComponent(
      joinUrlParts(
        "https://nested-user",
        ":",
        "nested-pass",
        "@nested.example/cb?access_token=",
        "nested-token",
      ),
    );
    const snapshot = projectSafeChannelAccountSnapshotFields({
      baseUrl: joinUrlParts(
        "https://outer-user",
        ":",
        "outer-pass",
        "@chat.example.test/?token=",
        "outer-token",
        `&next=${nested}#auth_token=`,
        "fragment-token",
      ),
    });

    expect(snapshot.baseUrl).not.toContain("outer-user");
    expect(snapshot.baseUrl).not.toContain("outer-pass");
    expect(snapshot.baseUrl).not.toContain("outer-token");
    expect(snapshot.baseUrl).not.toContain("nested-user");
    expect(snapshot.baseUrl).not.toContain("nested-pass");
    expect(snapshot.baseUrl).not.toContain("nested-token");
    expect(snapshot.baseUrl).not.toContain("fragment-token");
    expect(snapshot.baseUrl).toContain("token=***");
  });

  it("redacts plugin snapshots without mutating raw account state", () => {
    const rawBaseUrl = joinUrlParts(
      "https://user",
      ":",
      "pass",
      "@chat.example.test/?token=",
      "secret",
    );
    const account = Object.freeze({
      baseUrl: rawBaseUrl,
    });
    const snapshot = { ...account };

    const redacted = redactChannelAccountSnapshotBaseUrl(snapshot);

    expect(redacted).toEqual({ baseUrl: "https://chat.example.test/?token=***" });
    expect(account.baseUrl).toBe(rawBaseUrl);
    expect(snapshot.baseUrl).toBe(rawBaseUrl);
  });

  it("retains object identity when a plugin snapshot baseUrl is already safe", () => {
    const snapshot = { baseUrl: "https://chat.example.test/?keep=visible" };
    expect(redactChannelAccountSnapshotBaseUrl(snapshot)).toBe(snapshot);
  });

  it("preserves non-secret transport liveness timestamps", () => {
    const snapshot = projectSafeChannelAccountSnapshotFields({
      connected: true,
      lastConnectedAt: 123,
      lastInboundAt: 123,
      lastOutboundAt: 234,
      lastMessageAt: null,
      lastEventAt: 345,
      lastTransportActivityAt: 456,
      channelAccessToken: "line-token",
      channelSecret: "line-secret", // pragma: allowlist secret
      probe: { ok: true, token: "probe-secret" },
    });

    expect(snapshot).toEqual({
      connected: true,
      lastConnectedAt: 123,
      lastInboundAt: 123,
      lastOutboundAt: 234,
      lastMessageAt: null,
      lastEventAt: 345,
      lastTransportActivityAt: 456,
    });
  });

  it("projects terminalDisconnect when present and omits it when absent", () => {
    const withFlag = projectSafeChannelAccountSnapshotFields({
      connected: false,
      terminalDisconnect: true,
    });
    expect(withFlag.terminalDisconnect).toBe(true);

    const withoutFlag = projectSafeChannelAccountSnapshotFields({ connected: false });
    expect(withoutFlag).not.toHaveProperty("terminalDisconnect");
  });
});
