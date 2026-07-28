// Windows CI scope tests cover paths with platform-specific runtime contracts.
import { describe, expect, it } from "vitest";

const { detectChangedScope } = await import("../../scripts/ci-changed-scope.mjs");

describe("detectChangedScope Windows routing", () => {
  it("routes SQLite transcript archive changes to Windows", () => {
    for (const archivePath of ["src/config/sessions/session-accessor.sqlite-archive.ts"]) {
      expect(detectChangedScope([archivePath]), archivePath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes shared test-state fixture changes to Windows", () => {
    for (const fixturePath of [
      "src/test-utils/openclaw-test-state.ts",
      "src/test-utils/openclaw-test-state.test.ts",
    ]) {
      expect(detectChangedScope([fixturePath]), fixturePath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes core SQLite state changes to Windows", () => {
    for (const sqlitePath of [
      "src/commands/doctor-sqlite-compact.ts",
      "src/infra/node-sqlite.ts",
      "src/infra/update-managed-service-handoff.ts",
      "src/state/openclaw-state-db.ts",
    ]) {
      expect(detectChangedScope([sqlitePath]), sqlitePath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes Windows SQLite path tests to Windows", () => {
    for (const testPath of [
      "src/infra/update-managed-service-handoff.test.ts",
      "src/state/openclaw-database-paths.windows.test.ts",
    ]) {
      expect(detectChangedScope([testPath]), testPath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });
});
