// Windows CI scope tests cover paths with platform-specific runtime contracts.
import { describe, expect, it } from "vitest";

const { detectChangedScope } = await import("../../scripts/ci-changed-scope.mjs");

describe("detectChangedScope Windows routing", () => {
  it("routes completion profile installation and its native proof to Windows", () => {
    for (const profilePath of [
      "src/cli/completion-runtime.ts",
      "src/cli/completion-runtime.windows.test.ts",
    ]) {
      expect(detectChangedScope([profilePath]), profilePath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
    expect(detectChangedScope(["src/cli/completion-runtime-extra.ts"]).runWindows).toBe(false);
  });

  it("routes the Canvas pnpm runner and its native regression to Windows", () => {
    for (const runnerPath of [
      "extensions/canvas/scripts/pnpm-runner.mjs",
      "extensions/canvas/scripts/pnpm-runner.test.ts",
    ]) {
      expect(detectChangedScope([runnerPath]), runnerPath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }

    expect(detectChangedScope(["extensions/canvas/src/a2ui-jsonl.ts"]).runWindows).toBe(false);
  });

  it("routes source CLI invocation owners and their native proof to Windows", () => {
    for (const sourceCliPath of [
      "src/infra/openclaw-cli-invocation.ts",
      "src/infra/openclaw-cli-invocation.test.ts",
      "src/infra/openclaw-cli-invocation.test-support.ts",
      "src/infra/openclaw-cli-shim.ts",
      "src/infra/openclaw-cli-shim.test.ts",
      "src/infra/openclaw-cli-shim.windows.test.ts",
    ]) {
      expect(detectChangedScope([sourceCliPath]), sourceCliPath).toMatchObject({
        runNode: true,
        runWindows: true,
        runMacos: false,
        runAndroid: false,
      });
    }

    for (const unrelatedPath of [
      "src/infra/openclaw-root.ts",
      "src/infra/openclaw-cli-other.test.ts",
      "src/infra/openclaw-cli-shim-extra.ts",
    ]) {
      expect(detectChangedScope([unrelatedPath]).runWindows, unrelatedPath).toBe(false);
    }
  });

  it("routes worker bundle producers, archives, installers, and regression coverage to Windows", () => {
    for (const bundlePath of [
      "src/shared/worker-bundle-archive.ts",
      "src/shared/worker-bundle-archive.test.ts",
      "src/shared/worker-bundle-hash.ts",
      "src/gateway/worker-environments/bundle.ts",
      "src/gateway/worker-environments/bundle.test.ts",
      "src/gateway/worker-environments/bundle-staging.ts",
      "src/node-host/node-worker-bundle-installer.ts",
      "src/node-host/node-worker-bundle-installer.test.ts",
    ]) {
      expect(detectChangedScope([bundlePath]), bundlePath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes paired-worker workspace transfer owners and native regression coverage to Windows", () => {
    for (const workspacePath of [
      "src/node-host/node-worker-transfer-client.ts",
      "src/node-host/node-worker-transfer-client.test.ts",
      "src/gateway/worker-environments/node-worker-tunnel.ts",
      "src/gateway/worker-environments/node-worker-tunnel.test.ts",
      "src/gateway/worker-environments/workspace-sync-scripts.ts",
      "src/gateway/worker-environments/workspace-sync-manifest.test.ts",
    ]) {
      expect(detectChangedScope([workspacePath]), workspacePath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
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

  it("routes shared test-state and process fixture owners to Windows", () => {
    for (const fixturePath of [
      "src/test-utils/openclaw-test-state.ts",
      "src/test-utils/openclaw-test-state.test.ts",
      "test/helpers/openclaw-test-instance.ts",
      "test/helpers/openclaw-test-instance.test.ts",
      "test/helpers/openclaw-test-instance.cli.test-support.mjs",
      "scripts/lib/managed-child-process.mts",
      "scripts/lib/vitest-resource-ownership.mts",
    ]) {
      expect(detectChangedScope([fixturePath]), fixturePath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
    expect(detectChangedScope(["test/helpers/promise.ts"]).runWindows).toBe(false);
    expect(
      detectChangedScope(["test/helpers/openclaw-test-instance-extra.test.ts"]).runWindows,
    ).toBe(false);
  });

  it("routes process-start identity and every consumer of it to Windows", () => {
    // The owner, the Windows probe behind it, and the consumers that admit or
    // recover work from that identity. The real-host proof only runs on this
    // lane, so if any of them stops routing here a Windows regression merges
    // unchecked. The proof itself is included: it is test-only, and test-only
    // paths do not reach the lane through the general Windows scope.
    for (const identityPath of [
      "src/shared/pid-alive.ts",
      "src/gateway/gateway-cron-process-identity.windows.test.ts",
      "src/infra/windows-process-start.ts",
      "src/infra/gateway-lock.ts",
      "src/node-host/node-worker-process-identity.ts",
      "src/cron/store/run-receipt-store.ts",
    ]) {
      expect(detectChangedScope([identityPath]), identityPath).toMatchObject({
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

  it("routes port diagnostics and their native proof to Windows", () => {
    for (const portPath of ["src/infra/ports-inspect.ts", "src/infra/ports.test.ts"]) {
      expect(detectChangedScope([portPath]), portPath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes LAN advertisement and its native PowerShell proof to Windows", () => {
    for (const lanPath of [
      "src/infra/advertised-lan-host.ts",
      "src/infra/advertised-lan-host.test.ts",
      "src/infra/advertised-lan-host.windows.test.ts",
    ]) {
      expect(detectChangedScope([lanPath]), lanPath).toMatchObject({
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
      "src/agents/tools/media-tool-file-url.windows.test.ts",
      "src/agents/tools/media-tool-shared.test.ts",
      "src/agents/tools/media-tool-shared.ts",
      "src/agents/tools/pdf-tool.test.ts",
      "src/agents/tools/pdf-tool.ts",
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

  it("routes OS-home path owners and native tool coverage to Windows", () => {
    for (const homePath of [
      "src/infra/home-dir.ts",
      "src/infra/home-dir.test.ts",
      "src/agents/agent-tools.read.ts",
      "src/agents/agent-tools.read.host-operations.test.ts",
      "src/agents/agent-tools.read.windows.test.ts",
      "src/agents/sessions/tools/path-utils.ts",
      "src/agents/sessions/tools/path-utils.test.ts",
    ]) {
      expect(detectChangedScope([homePath]), homePath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes child environment resolution and native doctor coverage to Windows", () => {
    for (const envPath of [
      "src/agents/provider-local-service.ts",
      "src/agents/provider-local-service.env-case.test.ts",
      "src/cli/mcp-cli.ts",
      "src/cli/mcp-cli.test.ts",
      "src/cli/mcp-cli.path-case.windows.test.ts",
      "src/infra/process-env.ts",
      "src/infra/process-env.test.ts",
    ]) {
      expect(detectChangedScope([envPath]), envPath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes node-host executable resolution and native coverage to Windows", () => {
    for (const executablePath of [
      "src/plugin-sdk/node-host.ts",
      "src/plugin-sdk/node-host.test.ts",
      "src/process/supervisor/supervisor.anchored-shell.real.test.ts",
      "src/process/terminal-pty.test.ts",
      "src/tui/tui.ts",
      "src/tui/tui.resolve-codex-bin.test.ts",
    ]) {
      expect(detectChangedScope([executablePath]), executablePath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes explicit memory extra-file owners and native coverage to Windows", () => {
    for (const memoryPath of [
      "packages/memory-host-sdk/src/host/explicit-extra-markdown.ts",
      "packages/memory-host-sdk/src/host/internal.ts",
      "packages/memory-host-sdk/src/host/internal.test.ts",
      "packages/memory-host-sdk/src/host/read-file.ts",
      "extensions/memory-core/src/cli-runtime-common.ts",
      "extensions/memory-core/src/memory-extra-file-path.windows.test.ts",
    ]) {
      expect(detectChangedScope([memoryPath]), memoryPath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes workspace quiescence owners and native coverage to Windows", () => {
    for (const quiescencePath of [
      "src/gateway/worker-environments/workspace-quiescence.ts",
      "src/gateway/worker-environments/workspace-quiescence-scripts.ts",
      "src/gateway/worker-environments/workspace-quiescence.test.ts",
      "src/gateway/worker-environments/workspace-quiescence.windows.test.ts",
    ]) {
      expect(detectChangedScope([quiescencePath]), quiescencePath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("routes SecretRef path-security changes and focused owner coverage to Windows", () => {
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
      "src/security/audit-fs.ts",
    ]) {
      expect(detectChangedScope([secretRefPath]), secretRefPath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });

  it("does not route SecretRef tests owned by non-Windows lanes", () => {
    for (const testPath of [
      "src/gateway/resolve-configured-secret-input-string.test.ts",
      "src/secrets/resolve.test.ts",
      "test/e2e/qa-lab/runtime/doctor-auth-secretref-checks.e2e.test.ts",
    ]) {
      expect(detectChangedScope([testPath]).runWindows, testPath).toBe(false);
    }
  });
});
