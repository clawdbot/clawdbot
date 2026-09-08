import path from "node:path";
import { captureUpdateCheckpointPreimages } from "./update-checkpoint.js";
import { createUpdateRun } from "./update-run-ledger.js";
import {
  bindUpdateRecoveryNativeManager,
  type UpdateRecoveryNativeIdentity,
  type UpdateRecoveryNativeFacts,
} from "./update-run-recovery-native.js";
import { bindUpdateRecoveryPreimages } from "./update-run-recovery-preimage.js";
import { beginUpdateRecovery } from "./update-run-recovery.js";
export async function setupNativeManagerFixture(
  root: string,
  platform: "darwin" | "win32" | "linux",
  enabled: boolean,
  scope: "user" | "system" = "user",
) {
  const options = { env: { HOME: root, OPENCLAW_STATE_DIR: root, OPENCLAW_PROFILE: "isolated" } };
  const fence = { assertCurrent() {} };
  const run = createUpdateRun({ trigger: "cli" }, options);
  const runtime = { root, nodePath: process.execPath, version: "1.0.0", buildId: null };
  let record = beginUpdateRecovery(
    { runId: run.runId, from: runtime, to: runtime },
    fence,
    options,
  );
  const source = record.source!;
  const binding = {
    runId: run.runId,
    stateDir: source.stateDir,
    configPath: source.configPath,
    fromRuntime: { root, nodePath: runtime.nodePath, version: runtime.version },
  };
  const artifactRoot = path.join(root, "artifacts");
  const ref = await captureUpdateCheckpointPreimages({
    artifactRoot,
    binding,
    assertSourcesQuiescent: () => {
      fence.assertCurrent();
    },
    resources: [
      { sourcePath: path.join(root, "service.env"), kind: "service", restore: "replace" },
    ],
  });
  record = await bindUpdateRecoveryPreimages(record, { ref, artifactRoot }, fence, options);
  const common = {
    runId: run.runId,
    stateDir: source.stateDir,
    configPath: source.configPath,
    profile: "isolated",
  };
  const identity: UpdateRecoveryNativeIdentity =
    platform === "win32"
      ? { ...common, platform, taskName: "\\OpenClaw-isolated" }
      : platform === "darwin"
        ? { ...common, platform, domain: "gui/501", label: "ai.openclaw.isolated" }
        : scope === "user"
          ? { ...common, platform, scope, unitName: "openclaw-isolated.service", uid: 0 }
          : { ...common, platform, scope, unitName: "openclaw-isolated.service" };
  let facts: UpdateRecoveryNativeFacts = {
    exists: true,
    enabled,
    loaded: true,
    stopped: false,
  };
  const original = { ...facts };
  const observe = async () => ({ identity, facts });
  const bind = () => bindUpdateRecoveryNativeManager(record, { identity, observe }, fence, options);
  return {
    root,
    options,
    fence,
    record,
    identity,
    original,
    observe,
    bind,
    runtime,
    binding,
    artifactRoot,
    setFacts(next: UpdateRecoveryNativeFacts) {
      facts = next;
    },
  };
}
