// Verifies the shared Node/Swift device identity coordinator path contract.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-utils/temp-dir.js";
import { resolveDeviceIdentityCoordinatorPaths } from "./device-identity-coordinator-paths.js";
import { resolveStateDatabaseCoordinatorPath } from "./state-database-coordinator.js";

type ContractFixture = {
  databasePath: string;
  stateDirectory: string;
  runtimeDirectory: string;
  uid: number;
  stateCoordinatorPath: string;
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
      resolveStateDatabaseCoordinatorPath({
        databasePath: fixture.databasePath,
        runtimeDirectory: fixture.runtimeDirectory,
        uid: fixture.uid,
      }),
    ).toBe(fixture.stateCoordinatorPath);
    expect(
      resolveDeviceIdentityCoordinatorPaths({
        databasePath: fixture.databasePath,
        stateDir: fixture.stateDirectory,
        uid: fixture.uid,
      }),
    ).toEqual(fixture.orderedExpectedPaths);
  });

  it("canonicalizes database and state paths through existing symlink ancestors", async () => {
    await withTestDir("openclaw-device-identity-path-contract-", async (rawRootDir) => {
      const rootDir = fs.realpathSync.native(rawRootDir);
      const canonicalStateDir = path.join(rootDir, "canonical-state");
      const aliasedStateDir = path.join(rootDir, "aliased-state");
      const runtimeDirectory = path.join(rootDir, "runtime");
      fs.mkdirSync(canonicalStateDir);
      fs.mkdirSync(runtimeDirectory);
      fs.symlinkSync(canonicalStateDir, aliasedStateDir);

      const common = { uid: fixture.uid };
      expect(
        resolveStateDatabaseCoordinatorPath({
          ...common,
          databasePath: path.join(aliasedStateDir, "state", "openclaw.sqlite"),
          runtimeDirectory,
        }),
      ).toBe(
        resolveStateDatabaseCoordinatorPath({
          ...common,
          databasePath: path.join(canonicalStateDir, "state", "openclaw.sqlite"),
          runtimeDirectory,
        }),
      );
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
