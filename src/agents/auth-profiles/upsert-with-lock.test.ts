import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  updateAuthProfileStoreWithLock: vi.fn(),
}));

vi.mock("./credential-normalize.js", () => ({
  normalizeAuthProfileCredential: (credential: unknown) => credential,
}));
vi.mock("./store.js", () => ({
  updateAuthProfileStoreWithLock: hoisted.updateAuthProfileStoreWithLock,
}));

import { upsertAuthProfileWithLockOrThrow } from "./upsert-with-lock.js";

describe("upsertAuthProfileWithLockOrThrow", () => {
  beforeEach(() => {
    hoisted.updateAuthProfileStoreWithLock.mockReset();
  });

  it("resolves after the locked store update succeeds", async () => {
    hoisted.updateAuthProfileStoreWithLock.mockResolvedValue({ version: 1, profiles: {} });

    await expect(
      upsertAuthProfileWithLockOrThrow({
        profileId: "test:default",
        credential: { type: "token", provider: "test", token: "secret" },
      }),
    ).resolves.toBeUndefined();
  });

  it("fails with the canonical retry guidance when the locked update fails", async () => {
    hoisted.updateAuthProfileStoreWithLock.mockResolvedValue(null);

    await expect(
      upsertAuthProfileWithLockOrThrow({
        profileId: "test:default",
        credential: { type: "token", provider: "test", token: "secret" },
      }),
    ).rejects.toThrow(
      "Failed to update auth profile store; the auth store lock may be busy. Wait a moment and retry.",
    );
  });
});
