// Windows CI scope tests cover paths with platform-specific runtime contracts.
import { describe, expect, it } from "vitest";

const { detectChangedScope, detectNodeFastScope } =
  await import("../../scripts/ci-changed-scope.mjs");

describe("detectChangedScope Windows routing", () => {
  it("routes Knip cleanup owners to Windows", () => {
    for (const ownerPath of [
      "scripts/check-deadcode-unused-files.mjs",
      "scripts/deadcode-knip-runner.mjs",
      "test/scripts/check-deadcode-unused-files.test.ts",
    ]) {
      expect(detectChangedScope([ownerPath]), ownerPath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("keeps Windows routing coverage in fast CI", () => {
    expect(detectNodeFastScope(["src/scripts/ci-changed-scope.windows.test.ts"])).toEqual({
      runFastOnly: true,
      runPluginContracts: false,
      runCiRouting: true,
    });
  });

  it("routes SQLite transcript archive changes to Windows", () => {
    for (const archivePath of [
      "src/config/sessions/session-accessor.sqlite-archive.ts",
      "src/config/sessions/session-accessor.sqlite-archive.worker.test.ts",
      "src/config/sessions/session-accessor.sqlite-archive.worker.ts",
    ]) {
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

  it("routes the OpenSSH resolver and its native proof to Windows", () => {
    for (const sshPath of ["src/infra/ssh-client.ts", "src/infra/ssh-client.windows.test.ts"]) {
      expect(detectChangedScope([sshPath]), sshPath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes MXC runtime changes and Windows-only suites to Windows", () => {
    for (const mxcPath of [
      "extensions/mxc/src/mxc-backend.ts",
      "extensions/mxc/test/mxc-backend.test.ts",
      "extensions/mxc/test/sandbox-policy-loader.test.ts",
    ]) {
      expect(detectChangedScope([mxcPath]), mxcPath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes exec script preflight changes and Windows-only coverage to Windows", () => {
    for (const preflightPath of [
      "src/agents/bash-tools.exec-script-preflight.ts",
      "src/agents/bash-tools.exec-script-target.ts",
      "src/agents/bash-tools.exec.script-preflight.test.ts",
    ]) {
      expect(detectChangedScope([preflightPath]), preflightPath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes exec allowlist matcher changes and Windows-only coverage to Windows", () => {
    for (const allowlistPath of [
      "src/infra/exec-allowlist-pattern.ts",
      "src/infra/exec-allowlist-pattern.test.ts",
    ]) {
      expect(detectChangedScope([allowlistPath]), allowlistPath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes safe removal changes and Windows-only coverage to Windows", () => {
    for (const safeRemovePath of [
      "src/infra/fs-safe-remove.ts",
      "src/infra/fs-safe-remove.test.ts",
    ]) {
      expect(detectChangedScope([safeRemovePath]), safeRemovePath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });
});
