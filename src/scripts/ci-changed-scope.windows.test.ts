// Windows CI scope tests cover paths with platform-specific runtime contracts.
import { describe, expect, it } from "vitest";

const { detectChangedScope } = await import("../../scripts/ci-changed-scope.mjs");

describe("detectChangedScope Windows routing", () => {
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
      "src/infra/update-managed-service-handoff-command.test.ts",
      "src/infra/update-managed-service-handoff-lifecycle.test.ts",
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

  it("routes web and Teams file URL handling to Windows", () => {
    for (const fileUrlPath of [
      "src/media/local-media-path.ts",
      "src/media/local-media-path.windows.test.ts",
      "src/media/local-roots.ts",
      "src/media/local-roots.test.ts",
      "src/media/web-media.ts",
      "src/media/web-media.file-url.windows.test.ts",
      "src/channels/inbound-event/media.ts",
      "src/channels/inbound-event/media.test.ts",
      "src/gateway/managed-image-attachments.ts",
      "src/gateway/managed-image-attachments.test.ts",
      "extensions/msteams/src/media-helpers.ts",
      "extensions/msteams/src/media-helpers.test.ts",
      "extensions/msteams/src/messenger.test.ts",
    ]) {
      expect(detectChangedScope([fileUrlPath]), fileUrlPath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes sandbox media staging file URL handling to Windows", () => {
    for (const fileUrlPath of [
      "src/auto-reply/reply/stage-sandbox-media.ts",
      "src/auto-reply/reply.triggers.trigger-handling.stages-inbound-media-into-sandbox-workspace.test.ts",
    ]) {
      expect(detectChangedScope([fileUrlPath]), fileUrlPath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes usage footer template changes and native coverage to Windows", () => {
    for (const templatePath of [
      "src/auto-reply/usage-bar/template.ts",
      "src/auto-reply/usage-bar/template.windows.test.ts",
    ]) {
      expect(detectChangedScope([templatePath]), templatePath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes media-understanding file URL changes and native coverage to Windows", () => {
    for (const mediaPath of [
      "src/media-understanding/attachments.cache.ts",
      "src/media-understanding/attachments.cache.test.ts",
      "src/media-understanding/attachments.normalize.ts",
      "src/media-understanding/attachments.normalize.test.ts",
      "src/media-understanding/attachments.file-url.windows.test.ts",
    ]) {
      expect(detectChangedScope([mediaPath]), mediaPath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes shared home display owners and visible command coverage to Windows", () => {
    for (const displayPath of [
      "src/utils.ts",
      "src/utils.test.ts",
      "src/infra/home-display.ts",
      "src/infra/path-guards.ts",
      "src/commands/agents.commands.list.ts",
      "src/commands/agents.commands.list.test.ts",
      "src/cli/daemon-cli/status.print.ts",
      "src/cli/daemon-cli/status.print.test.ts",
      "packages/terminal-core/src/display-string.ts",
      "packages/terminal-core/src/display-string.test.ts",
      "src/agents/sandbox/fs-paths.ts",
      "src/agents/sandbox/fs-paths.test.ts",
      "src/agents/sessions/tools/render-utils.ts",
      "src/agents/sessions/tools/render-utils.test.ts",
    ]) {
      expect(detectChangedScope([displayPath]), displayPath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes MCP environment resolution and native doctor coverage to Windows", () => {
    for (const mcpPath of [
      "src/cli/mcp-cli.ts",
      "src/cli/mcp-cli.test.ts",
      "src/cli/mcp-cli.path-case.windows.test.ts",
      "src/infra/process-env.ts",
      "src/infra/process-env.test.ts",
    ]) {
      expect(detectChangedScope([mcpPath]), mcpPath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes SecretRef path-security changes and native fixtures to Windows", () => {
    for (const secretRefPath of [
      "src/commands/doctor-gateway-auth-token.ts",
      "src/commands/doctor-gateway-auth-token.windows.test.ts",
      "src/flows/doctor-core-checks.ts",
      "src/flows/doctor-health-contributions.ts",
      "src/gateway/auth-token-resolution.ts",
      "src/gateway/resolve-configured-secret-input-string.ts",
      "src/infra/fs-safe.ts",
      "src/infra/fs-safe-defaults.ts",
      "src/infra/permissions.ts",
      "src/secrets/resolve-errors.ts",
      "src/secrets/resolve.ts",
      "src/secrets/test-node-command.test-support.ts",
      "src/security/audit-fs.ts",
      "src/test-utils/vitest-spies.ts",
      "test/e2e/qa-lab/runtime/doctor-auth-secretref-checks.e2e.test.ts",
      "test/fixtures/windows-acl-tools-unavailable.mjs",
    ]) {
      expect(detectChangedScope([secretRefPath]), secretRefPath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("does not route SecretRef unit tests omitted from the Windows shard", () => {
    for (const testPath of [
      "src/gateway/resolve-configured-secret-input-string.test.ts",
      "src/secrets/resolve.test.ts",
    ]) {
      expect(detectChangedScope([testPath]).runWindows, testPath).toBe(false);
    }
  });
});
