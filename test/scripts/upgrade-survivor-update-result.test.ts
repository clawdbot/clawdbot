import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const command = resolve("scripts/e2e/lib/upgrade-survivor/assertions.mjs");

function deniedUpdate() {
  return {
    status: "error",
    mode: "npm",
    reason: "post-update-plugins",
    before: { version: "2026.7.1-2" },
    after: { version: "2026.8.1" },
    steps: [
      { name: "global update", exitCode: 0 },
      { name: "global install swap", exitCode: 0 },
    ],
    postUpdate: {
      plugins: {
        status: "error",
        reason: "post-plugin-doctor-invalid-config",
        sync: { errors: [] as string[] },
        npm: { outcomes: [] as { status: string }[] },
        integrityDrifts: [] as string[],
        warnings: ["codex", "discord", "whatsapp"].map((id) => {
          const message = `Plugin "${id}" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.`;
          return { reason: message, message };
        }),
      },
    },
  };
}

function deferredUpdate() {
  const update = deniedUpdate();
  const codexWarning = expectDefined(
    update.postUpdate.plugins.warnings[0],
    "Codex consent warning",
  );
  const reason = 'Plugin "codex" requires capability consent; rerun with --accept-capabilities.';
  const message = `Plugin "codex" could not be processed after the core update: ${reason} Run openclaw update repair to retry post-update plugin repair. Run openclaw plugins inspect codex --runtime --json for details.`;
  const retained = `Kept installed plugin "codex"; replacement deferred. ${codexWarning.reason}`;
  return {
    ...update,
    status: "ok",
    reason: undefined,
    postUpdate: {
      plugins: {
        ...update.postUpdate.plugins,
        status: "warning",
        reason: undefined,
        npm: {
          outcomes: [
            {
              pluginId: "codex",
              status: "error",
              code: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
              message,
            },
            { pluginId: "discord", status: "updated", nextVersion: "2026.8.1" },
          ],
        },
        warnings: [
          { reason, message },
          expectDefined(update.postUpdate.plugins.warnings[2], "WhatsApp consent warning"),
          { reason: retained, message: retained },
        ],
      },
    },
  };
}

function check(result: unknown, prefix = "") {
  const filename = join(tempDirs.make("survivor-update-result-"), "update.json");
  writeFileSync(filename, prefix + JSON.stringify(result));
  return spawnSync(
    process.execPath,
    [command, "assert-recoverable-update-json", filename, "2026.8.1", "", "2026.7.1-2"],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

describe("published upgrade survivor consent recovery", () => {
  it.each(
    ["acpx", "feishu"].flatMap((pluginId) =>
      ["error", "ok"].map((status) => ({ pluginId, status })),
    ),
  )("admits $pluginId fixture consent after a $status update", ({ pluginId, status }) => {
    const update = deniedUpdate();
    const reason = `Plugin "${pluginId}" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.`;
    update.postUpdate.plugins.warnings.push({ reason, message: reason });
    const result = check({
      ...update,
      status,
      reason: status === "error" ? update.reason : undefined,
      postUpdate: {
        plugins: {
          ...update.postUpdate.plugins,
          status: status === "error" ? "error" : "warning",
          reason: status === "error" ? update.postUpdate.plugins.reason : undefined,
        },
      },
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["acpx", "feishu"])("rejects non-consent failures from reviewed %s", (pluginId) => {
    const update = deferredUpdate();
    const outcome = expectDefined(update.postUpdate.plugins.npm.outcomes[0], "plugin outcome");
    outcome.pluginId = pluginId;
    outcome.code = "INSTALL_FAILED";
    expect(check(update).status).not.toBe(0);
  });

  it("repairs capability deferrals even when retaining the old plugin makes core update successful", () => {
    const result = check(deferredUpdate());
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["INSTALL_FAILED", undefined])("rejects unrelated plugin outcome %s", (code) => {
    const update = deferredUpdate();
    expectDefined(update.postUpdate.plugins.npm.outcomes[0], "Codex update outcome").code = code;
    expect(check(update).status).not.toBe(0);
  });

  it("accepts only the reviewed externalized fixture packages after successful core replacement", () => {
    const update = deniedUpdate();
    update.postUpdate.plugins.warnings.push({
      reason: "Config remained invalid after updated plugin migrations.",
      message: "Post-update plugin migration did not produce a valid config; refusing to restart.",
    });
    const result = check(update);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    [
      "core update failure",
      (result: ReturnType<typeof deniedUpdate>) =>
        (expectDefined(result.steps[0], "global update step").exitCode = 1),
    ],
    [
      "wrong installed version",
      (result: ReturnType<typeof deniedUpdate>) => (result.after.version = "2026.7.1-2"),
    ],
    [
      "wrong baseline version",
      (result: ReturnType<typeof deniedUpdate>) => (result.before.version = "2026.8.1"),
    ],
    ["missing core swap", (result: ReturnType<typeof deniedUpdate>) => result.steps.pop()],
    [
      "other update failure",
      (result: ReturnType<typeof deniedUpdate>) => (result.reason = "doctor"),
    ],
    [
      "plugin sync failure",
      (result: ReturnType<typeof deniedUpdate>) =>
        result.postUpdate.plugins.sync.errors.push("network failed"),
    ],
    [
      "plugin update failure",
      (result: ReturnType<typeof deniedUpdate>) =>
        result.postUpdate.plugins.npm.outcomes.push({ status: "error" }),
    ],
    [
      "integrity drift",
      (result: ReturnType<typeof deniedUpdate>) =>
        result.postUpdate.plugins.integrityDrifts.push("changed"),
    ],
    [
      "unreviewed plugin",
      (result: ReturnType<typeof deniedUpdate>) => {
        const warning = expectDefined(
          result.postUpdate.plugins.warnings[0],
          "Codex consent warning",
        );
        warning.reason = warning.reason.replace("codex", "unreviewed");
        warning.message = warning.reason;
      },
    ],
    [
      "unrelated warning",
      (result: ReturnType<typeof deniedUpdate>) =>
        result.postUpdate.plugins.warnings.push({
          reason: "broken config",
          message: "broken config",
        }),
    ],
    [
      "no consent denial",
      (result: ReturnType<typeof deniedUpdate>) => (result.postUpdate.plugins.warnings = []),
    ],
  ])("refuses repair after %s", (_name, mutate) => {
    const result = deniedUpdate();
    mutate(result);
    expect(check(result).status).not.toBe(0);
  });
});
