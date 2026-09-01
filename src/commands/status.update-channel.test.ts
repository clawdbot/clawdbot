import { describe, expect, it, vi } from "vitest";

const versionMock = vi.hoisted(() => ({ value: "2026.6.33" }));

vi.mock("../version.js", () => ({
  get VERSION() {
    return versionMock.value;
  },
}));

const { resolveStatusRegistryUpdateChannel } = await import("./status.update.js");

describe("resolveStatusRegistryUpdateChannel", () => {
  it("uses extended-stable only for a verified package install", () => {
    expect(
      resolveStatusRegistryUpdateChannel({
        installKind: "package",
      }),
    ).toBe("extended-stable");
    expect(
      resolveStatusRegistryUpdateChannel({
        installKind: "git",
        git: {
          tag: null,
          branch: "main",
        },
      }),
    ).toBe("dev");
  });
});
