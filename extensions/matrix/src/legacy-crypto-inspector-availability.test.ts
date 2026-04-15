import { beforeEach, describe, expect, it, vi } from "vitest";

const availabilityState = vi.hoisted(() => ({
  currentFilePath: "/virtual/dist/matrix-migration.runtime.js",
  existingPaths: new Set<string>(),
  dirEntries: [] as Array<{ name: string; isFile: () => boolean }>,
}));

vi.mock("node:fs", async () => {
  const { mockNodeBuiltinModule } = await import("../../../test/helpers/node-builtin-mocks.js");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:fs")>("node:fs"),
    {
      existsSync: (candidate: unknown) => availabilityState.existingPaths.has(String(candidate)),
      readdirSync: () => availabilityState.dirEntries as never,
    },
    { mirrorToDefault: true },
  );
});

vi.mock("node:url", async () => {
  const actual = await vi.importActual<typeof import("node:url")>("node:url");
  return {
    ...actual,
    fileURLToPath: () => availabilityState.currentFilePath,
  };
});

const { isMatrixLegacyCryptoInspectorAvailable } =
  await import("./legacy-crypto-inspector-availability.js");

describe("isMatrixLegacyCryptoInspectorAvailable", () => {
  beforeEach(() => {
    availabilityState.currentFilePath = "/virtual/dist/matrix-migration.runtime.js";
    availabilityState.existingPaths.clear();
    availabilityState.dirEntries = [];
  });

  it("detects the source inspector module directly", () => {
    availabilityState.currentFilePath =
      "/virtual/extensions/matrix/src/legacy-crypto-inspector-availability.js";
    availabilityState.existingPaths.add(
      "/virtual/extensions/matrix/src/matrix/legacy-crypto-inspector.ts",
    );

    expect(isMatrixLegacyCryptoInspectorAvailable()).toBe(true);
  });

  it("detects hashed built inspector chunks", () => {
    availabilityState.dirEntries = [
      {
        name: "legacy-crypto-inspector-TPlLnFSE.js",
        isFile: () => true,
      },
    ];

    expect(isMatrixLegacyCryptoInspectorAvailable()).toBe(true);
  });

  it("does not confuse the availability helper artifact with the real inspector", () => {
    availabilityState.dirEntries = [
      {
        name: "legacy-crypto-inspector-availability.js",
        isFile: () => true,
      },
    ];

    expect(isMatrixLegacyCryptoInspectorAvailable()).toBe(false);
  });

  it("does not confuse hashed availability helper chunks with the real inspector", () => {
    availabilityState.dirEntries = [
      {
        name: "legacy-crypto-inspector-availability-TPlLnFSE.js",
        isFile: () => true,
      },
    ];

    expect(isMatrixLegacyCryptoInspectorAvailable()).toBe(false);
  });
});
