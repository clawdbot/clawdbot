import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { readTriageUpdateFailure, writeTriageUpdateFailure } from "./triage-update.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("update failure triage diagnostics", () => {
  it("writes only bounded sanitized failure evidence and preserves the original update result", async () => {
    const home = tempDirs.make("openclaw-update-triage-");
    const stateDir = path.join(home, ".openclaw");
    const env = { HOME: home, OPENCLAW_STATE_DIR: stateDir };
    const secret = "sk-test-update-triage-secret-1234567890";
    const result: UpdateRunResult = {
      status: "error",
      mode: "npm",
      root: path.join(home, "npm", "openclaw"),
      reason: "Package install failed",
      before: { version: "2026.8.1" },
      recovery: {
        serviceRestartSafe: true,
        version: "2026.8.1",
        buildId: "verified-recovery-build",
        service: "healthy",
      },
      durationMs: 10,
      steps: Array.from({ length: 5 }, (_, index) => ({
        name: `step-${index}`,
        command: `unredacted-command --token ${secret}`,
        cwd: home,
        durationMs: 1,
        exitCode: index === 0 ? 0 : 1,
        stdoutTail: `${"Earlier build output\n".repeat(100)}The compiler reported the actual failure on stdout`,
        stderrTail: `token=${secret}\n${"🦞".repeat(8_000)} ${stateDir}/npm.log terminal failure token=${secret}`,
        advisory:
          index === 4
            ? { kind: "package-post-install-doctor" as const, message: "Recoverable Doctor advice" }
            : undefined,
      })),
    };

    const outputPath = await writeTriageUpdateFailure({ result }, { env });
    const raw = await fs.readFile(outputPath, "utf8");
    const failure = await readTriageUpdateFailure(outputPath, { env, stateDir });

    expect(outputPath.startsWith(path.join(stateDir, "logs", "support"))).toBe(true);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(8 * 1024);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(home);
    expect(raw).not.toContain("unredacted-command");
    expect(raw).not.toContain("\uFFFD");
    expect(failure).toMatchObject({
      result: {
        reason: "Package install failed",
        before: { version: "2026.8.1" },
        recovery: result.recovery,
      },
    });
    expect("result" in failure && failure.result.steps.map((step) => step.name)).toEqual([
      "step-1",
      "step-2",
      "step-3",
    ]);
    expect(raw).toContain("actual failure on stdout");
    expect(raw).toContain("npm.log");
    expect(raw).not.toContain("step-4");
    expect(result.steps).toHaveLength(5);
    expect(result.steps[0]?.command).toContain(secret);
    if (process.platform !== "win32") {
      expect((await fs.stat(outputPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("preserves a post-install activation error even when the core update succeeded", async () => {
    const stateDir = tempDirs.make("openclaw-update-triage-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const failure = {
      result: {
        status: "ok" as const,
        mode: "git" as const,
        after: { version: "2026.9.1" },
        steps: [],
      },
      error: `Gateway activation failed ${"intermediate context ".repeat(100)}terminal recovery cause`,
    };
    const outputPath = await writeTriageUpdateFailure(failure, { env });

    const recorded = await readTriageUpdateFailure(outputPath, { env, stateDir });
    expect(recorded).toMatchObject({ result: failure.result });
    expect(recorded.error).toContain("Gateway activation failed");
    expect(recorded.error).toContain("terminal recovery cause");
  });

  it("retains package rollback proof without promoting restart safety", async () => {
    const stateDir = tempDirs.make("openclaw-update-triage-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const outputPath = await writeTriageUpdateFailure(
      {
        result: {
          status: "error",
          mode: "npm",
          reason: "openclaw doctor",
          before: { version: "2026.8.1" },
          after: { version: "2026.8.1" },
          steps: [],
          recovery: {
            serviceRestartSafe: false,
            reason: "runtime-verification-failed",
            packageRollbackVerified: true,
          },
        },
      },
      { env },
    );

    const recorded = await readTriageUpdateFailure(outputPath, { env, stateDir });

    expect(recorded).toMatchObject({
      result: {
        recovery: {
          serviceRestartSafe: false,
          reason: "runtime-verification-failed",
          packageRollbackVerified: true,
        },
      },
    });
  });

  it("retains actual plugin sync and npm errors after a successful core replacement", async () => {
    const stateDir = tempDirs.make("openclaw-update-triage-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const failure = {
      result: {
        status: "error" as const,
        mode: "npm" as const,
        reason: "post-update-plugins",
        steps: [],
        postUpdate: {
          plugins: {
            status: "error" as const,
            sync: { errors: ["Configured plugin package is unavailable"] },
            npm: {
              outcomes: [
                {
                  pluginId: "fixture-ok",
                  status: "updated" as const,
                  message: "Updated successfully",
                },
                {
                  pluginId: "fixture-failed",
                  status: "error" as const,
                  message: "Plugin dependency resolution failed",
                },
              ],
            },
          },
        },
      },
    };
    const outputPath = await writeTriageUpdateFailure(failure, { env });
    const raw = await fs.readFile(outputPath, "utf8");

    expect(raw).toContain("Configured plugin package is unavailable");
    expect(raw).toContain("Plugin dependency resolution failed");
    expect(raw).not.toContain("fixture-ok");
    expect(await readTriageUpdateFailure(outputPath, { env, stateDir })).toMatchObject({
      result: { reason: "post-update-plugins" },
    });
  });

  it("retains fresh Doctor failure warnings through repeated diagnostic handoffs", async () => {
    const stateDir = tempDirs.make("openclaw-update-triage-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const failure = {
      result: {
        status: "error" as const,
        mode: "npm" as const,
        reason: "post-update-plugins",
        steps: [],
        postUpdate: {
          plugins: {
            status: "error" as const,
            reason: "post-plugin-doctor-invalid-config",
            sync: { errors: [] },
            npm: { outcomes: [] },
            warnings: [
              ...Array.from({ length: 5 }, (_, index) => ({
                reason: `Earlier warning ${index}`,
                message: "Plugin installation needs attention",
              })),
              {
                reason: "Fresh Doctor could not load updated runtime",
                message: "Migration failed",
              },
              { reason: "Config remained invalid", message: "Refusing to restart" },
            ],
          },
        },
      },
    };
    const outputPath = await writeTriageUpdateFailure(failure, { env });
    const once = await readTriageUpdateFailure(outputPath, { env, stateDir });
    const secondPath = await writeTriageUpdateFailure(once, { env });
    const twice = await readTriageUpdateFailure(secondPath, { env, stateDir });

    expect(twice).toEqual(once);
    expect(twice).toMatchObject({ omittedDetails: 4 });
    expect(JSON.stringify(twice)).toContain("Fresh Doctor could not load updated runtime");
    expect(JSON.stringify(twice)).toContain("Refusing to restart");
    expect(JSON.stringify(twice)).not.toContain("Earlier warning 0");
  });

  it("reserves the terminal plugin warning before earlier errors exhaust the diagnostic budget", async () => {
    const stateDir = tempDirs.make("openclaw-update-triage-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const outputPath = await writeTriageUpdateFailure(
      {
        result: {
          status: "error",
          mode: "npm",
          reason: "post-update-plugins",
          steps: [],
          postUpdate: {
            plugins: {
              status: "error",
              sync: {
                errors: ["Earlier failure one", "Earlier failure two", "Earlier failure three"],
              },
              warnings: [{ reason: "Terminal Doctor failure", message: "Refusing to restart" }],
            },
          },
        },
      },
      { env },
    );
    const recorded = await readTriageUpdateFailure(outputPath, { env, stateDir });

    expect(recorded).toMatchObject({
      omittedDetails: 1,
      result: {
        postUpdate: {
          plugins: {
            sync: { errors: ["Earlier failure one", "Earlier failure two"] },
            warnings: [{ reason: "Terminal Doctor failure", message: "Refusing to restart" }],
          },
        },
      },
    });
  });

  it.each(["dirty", "no-upstream", "not-git"])(
    "accepts skipped %s attempts classified as failures",
    async (reason) => {
      const stateDir = tempDirs.make("openclaw-update-triage-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const failure = {
        result: { status: "skipped" as const, mode: "git" as const, reason, steps: [] },
      };
      const outputPath = await writeTriageUpdateFailure(failure, { env });

      expect(await readTriageUpdateFailure(outputPath, { env, stateDir })).toMatchObject(failure);
    },
  );

  it.each([
    { name: "oversized", input: "x".repeat(8 * 1024 + 1), error: "exceeds 8192 bytes" },
    { name: "invalid JSON", input: "not-json", error: "Invalid update failure diagnostics JSON" },
    {
      name: "successful result without an error",
      input: JSON.stringify({ result: { status: "ok", mode: "npm", steps: [] } }),
      error: "expected a failed result or error",
    },
    {
      name: "invalid result beside a valid error",
      input: JSON.stringify({ result: {}, error: "original failure" }),
      error: "expected a failed result or error",
    },
  ])("rejects $name diagnostic input", async ({ input, error }) => {
    const stateDir = tempDirs.make("openclaw-update-triage-");
    const inputPath = path.join(stateDir, "failure.json");
    await fs.writeFile(inputPath, input);

    await expect(readTriageUpdateFailure(inputPath, { env: {}, stateDir })).rejects.toThrow(error);
  });
});
