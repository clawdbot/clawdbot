import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPolicyReadinessCriterion } from "./readiness.js";

let workspaceDir: string;

function policyConfig(enabled = true) {
  return {
    agents: { defaults: { workspace: workspaceDir } },
    plugins: { entries: { policy: { enabled, config: { enabled } } } },
  };
}

async function check(config = policyConfig()) {
  return createPolicyReadinessCriterion().check({
    config,
    pluginConfig: config.plugins.entries.policy.config,
    signal: new AbortController().signal,
  });
}

describe("policy readiness", () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(join(tmpdir(), "policy-readiness-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("reports a clean enabled policy", async () => {
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), "{}", "utf-8");

    await expect(check()).resolves.toEqual({
      status: "True",
      reason: "PolicyConformant",
      message: "Policy evaluation completed without findings.",
    });
  });

  it("reports policy findings without exposing their contents", async () => {
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), "{", "utf-8");

    await expect(check()).resolves.toEqual({
      status: "False",
      reason: "PolicyFindingsPresent",
      message: "Policy evaluation reported 1 finding(s).",
    });
  });

  it("reports disabled policy checks as unavailable", async () => {
    await expect(check(policyConfig(false))).resolves.toEqual({
      status: "Unknown",
      reason: "PolicyChecksDisabled",
      message: "Policy checks are not enabled for this runtime.",
    });
  });

  it("honors an already-aborted readiness evaluation", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      createPolicyReadinessCriterion().check({
        config: policyConfig(),
        pluginConfig: {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
