import { describe, expect, it } from "vitest";
import {
  mintNodeWorkspaceTransferToken,
  verifyNodeWorkspaceTransferToken,
} from "./node-workspace-transfer-token.js";

const NOW = 1_900_000_000_000;
const EXPIRY = NOW + 10 * 60_000;
const CREDENTIAL_HASH = "a".repeat(43);

function mint() {
  return mintNodeWorkspaceTransferToken({
    credentialHash: CREDENTIAL_HASH,
    credentialExpiresAtMs: EXPIRY,
    environmentId: "environment-a",
    ownerEpoch: 4,
    direction: "download",
    nowMs: NOW,
  });
}

function verify(token: string, overrides: Record<string, unknown> = {}) {
  return verifyNodeWorkspaceTransferToken({
    token,
    credentialHash: CREDENTIAL_HASH,
    credentialExpiresAtMs: EXPIRY,
    environmentId: "environment-a",
    ownerEpoch: 4,
    direction: "download",
    nowMs: NOW,
    ...overrides,
  });
}

describe("node workspace transfer token", () => {
  it("accepts only the current environment owner and direction", () => {
    const { token } = mint();
    expect(verify(token)).toBe(true);
    expect(verify(token, { environmentId: "environment-b" })).toBe(false);
    expect(verify(token, { ownerEpoch: 5 })).toBe(false);
    expect(verify(token, { direction: "upload" })).toBe(false);
    expect(verify(token, { credentialHash: "b".repeat(43) })).toBe(false);
  });

  it("caps validity at the credential expiry and rejects expiry", () => {
    const { token, expiresAtMs } = mint();
    expect(expiresAtMs).toBe(NOW + 5 * 60_000);
    expect(verify(token, { nowMs: expiresAtMs })).toBe(false);
    expect(verify(token, { credentialExpiresAtMs: expiresAtMs - 1 })).toBe(false);
  });
});
