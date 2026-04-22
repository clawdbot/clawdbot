import { describe, expect, it } from "vitest";
import { projectSafeChannelAccountSnapshotFields } from "./account-snapshot-fields.js";

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

  it("preserves non-secret transport liveness timestamps", () => {
    const snapshot = projectSafeChannelAccountSnapshotFields({
      lastInboundAt: 123,
      lastTransportActivityAt: 456,
    });

    expect(snapshot).toEqual({
      lastInboundAt: 123,
      lastTransportActivityAt: 456,
    });
  });
});
