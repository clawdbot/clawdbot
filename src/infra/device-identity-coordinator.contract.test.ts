// Verifies the shared Node/Swift device identity coordinator path contract.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { resolveDeviceIdentityCoordinatorPaths } from "./device-identity-coordinator-paths.js";

type ContractFixture = {
  databasePath: string;
  stateDirectory: string;
  temporaryDirectory: string;
  uid: number;
  orderedExpectedPaths: string[];
};

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("../../test/fixtures/device-identity-coordinator-contract.json", import.meta.url),
    "utf8",
  ),
) as ContractFixture;

describe.skipIf(process.platform === "win32")("device identity coordinator contract", () => {
  it("matches the shared ordered path vector", () => {
    expect(
      resolveDeviceIdentityCoordinatorPaths({
        databasePath: fixture.databasePath,
        stateDir: fixture.stateDirectory,
        temporaryDirectory: fixture.temporaryDirectory,
        uid: fixture.uid,
      }),
    ).toEqual(fixture.orderedExpectedPaths);
  });

  it("deduplicates coincident process-temp and state-local paths", () => {
    const stateLocalPath = fixture.orderedExpectedPaths[1];
    if (!stateLocalPath) {
      throw new Error("state-local fixture path is unavailable");
    }
    expect(
      resolveDeviceIdentityCoordinatorPaths({
        databasePath: fixture.databasePath,
        stateDir: fixture.stateDirectory,
        temporaryDirectory: path.join(fixture.stateDirectory, "tmp"),
        uid: fixture.uid,
      }),
    ).toEqual([stateLocalPath]);
  });

  it("canonicalizes database and state paths through existing symlink ancestors", async () => {
    await withTempDir("openclaw-device-identity-path-contract-", async (rawRootDir) => {
      const rootDir = fs.realpathSync.native(rawRootDir);
      const canonicalStateDir = path.join(rootDir, "canonical-state");
      const aliasedStateDir = path.join(rootDir, "aliased-state");
      const temporaryDirectory = path.join(rootDir, "process-temp");
      fs.mkdirSync(canonicalStateDir);
      fs.symlinkSync(canonicalStateDir, aliasedStateDir);

      const common = { temporaryDirectory, uid: fixture.uid };
      expect(
        resolveDeviceIdentityCoordinatorPaths({
          ...common,
          databasePath: path.join(aliasedStateDir, "state", "openclaw.sqlite"),
          stateDir: aliasedStateDir,
        }),
      ).toEqual(
        resolveDeviceIdentityCoordinatorPaths({
          ...common,
          databasePath: path.join(canonicalStateDir, "state", "openclaw.sqlite"),
          stateDir: canonicalStateDir,
        }),
      );
    });
  });
});
