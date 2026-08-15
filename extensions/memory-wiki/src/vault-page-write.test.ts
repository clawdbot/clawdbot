// Memory Wiki tests cover the shared guarded vault page write helper.
import { FsSafeError } from "openclaw/plugin-sdk/security-runtime";
import { describe, expect, it, vi } from "vitest";
import { writeGuardedVaultPage } from "./vault-page-write.js";

type FakeVault = Parameters<typeof writeGuardedVaultPage>[0]["vault"];

function fakeVault(write: () => Promise<void>): {
  vault: FakeVault;
  remove: ReturnType<typeof vi.fn>;
} {
  const remove = vi.fn(async () => {});
  return { vault: { write: vi.fn(write), remove } as unknown as FakeVault, remove };
}

describe("writeGuardedVaultPage", () => {
  it("recovers from a transient concurrent-rewrite path-mismatch by retrying", async () => {
    let attempts = 0;
    const { vault } = fakeVault(async () => {
      attempts += 1;
      if (attempts < 3) {
        // A concurrent atomic rewrite replaces the page mid-operation.
        throw new FsSafeError("path-mismatch", "unable to resolve opened file path");
      }
    });

    await expect(
      writeGuardedVaultPage({
        vault,
        pagePath: "sources/page.md",
        content: "body",
        pageStat: null,
        pageLabel: "imported source page",
      }),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(3);
  });

  it("rethrows a labeled error when the path-mismatch persists across attempts", async () => {
    const { vault } = fakeVault(async () => {
      throw new FsSafeError("path-mismatch", "unable to resolve opened file path");
    });

    await expect(
      writeGuardedVaultPage({
        vault,
        pagePath: "sources/page.md",
        content: "body",
        pageStat: null,
        pageLabel: "imported source page",
      }),
    ).rejects.toThrow(
      /Refusing to write imported source page \(path-mismatch\): sources\/page\.md/u,
    );
  });

  it("does not retry persistent non-race guard failures and keeps fatal wording", async () => {
    const { vault } = fakeVault(async () => {
      throw new FsSafeError("not-file", "target is not a regular file");
    });

    await expect(
      writeGuardedVaultPage({
        vault,
        pagePath: "concepts/page.md",
        content: "body",
        pageStat: null,
        pageLabel: "OKF concept page",
      }),
    ).rejects.toThrow(/Refusing to write OKF concept page \(not-file\): concepts\/page\.md/u);
    expect((vault as unknown as { write: ReturnType<typeof vi.fn> }).write).toHaveBeenCalledTimes(
      1,
    );
  });

  it("maps symlink and path-alias swaps to the symlink wording without retrying", async () => {
    const { vault } = fakeVault(async () => {
      throw new FsSafeError("symlink", "page resolved through a symlink");
    });

    await expect(
      writeGuardedVaultPage({
        vault,
        pagePath: "sources/page.md",
        content: "body",
        pageStat: null,
        pageLabel: "imported source page",
      }),
    ).rejects.toThrow(/Refusing to write imported source page through symlink: sources\/page\.md/u);
    expect((vault as unknown as { write: ReturnType<typeof vi.fn> }).write).toHaveBeenCalledTimes(
      1,
    );
  });
});
