import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/mantis-telegram-desktop-proof.yml";
const PROMPT = ".github/codex/prompts/mantis-telegram-visible-proof.md";

type Step = {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

function workflow() {
  return parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
}

function proofSteps() {
  return workflow().jobs?.run_telegram_visible_proof?.steps ?? [];
}

describe("Mantis Telegram proof workflow", () => {
  it("gives one Codex run unrestricted scenario ownership", () => {
    const prompt = readFileSync(PROMPT, "utf8");
    const agent = readFileSync("scripts/mantis/telegram-visible-run-agent.sh", "utf8");
    const step = proofSteps().find(
      (entry) => entry.name === "Run open-ended Telegram investigation with GPT-5.6",
    );

    expect(step?.run).toContain("telegram-visible-run-agent.sh");
    expect(agent).toContain("--sandbox danger-full-access");
    expect(agent).not.toContain("resume --last");
    expect(prompt).toMatch(/There is no scenario schema or\s+assertion language/u);
    expect(prompt).toMatch(/Baseline and\s+candidate do not need identical commands/u);
    expect(prompt).toMatch(/Change any OpenClaw\s+setting inside either SUT/u);
  });

  it("keeps only provenance collection after the agent run", () => {
    const names = proofSteps().map((step) => step.name);
    expect(names).toContain("Collect trusted Telegram evidence");
    expect(names).not.toContain("Freeze the final scenario and discard exploration");
    expect(names).not.toContain("Replay identical scenario on main and pull request");
    expect(names).not.toContain("Evaluate only Telegram-visible evidence");

    for (const removed of [
      "scripts/mantis/telegram-visible-proof-contract.mjs",
      "scripts/mantis/telegram-visible-proof-events.mjs",
      "scripts/mantis/telegram-visible-proof-evidence.mjs",
      "scripts/mantis/telegram-visible-freeze-scenario.sh",
      "scripts/mantis/telegram-visible-replay-scenario.sh",
      "scripts/mantis/telegram-proof-scenario.sh",
    ]) {
      expect(existsSync(removed)).toBe(false);
    }
  });

  it("fences every SUT lane before trusted collection", () => {
    const steps = proofSteps();
    const cleanupStep = steps.findIndex((step) => step.name === "Clean up Mantis sessions");
    const collectStep = steps.findIndex(
      (step) => step.name === "Collect trusted Telegram evidence",
    );
    const collectConfig = steps[collectStep];
    const cleanup = readFileSync("scripts/mantis/telegram-visible-cleanup-proof.sh", "utf8");
    const collect = readFileSync("scripts/mantis/telegram-visible-collect-proof.sh", "utf8");
    const snapshot = collect.indexOf('install -m 0400 "$output_root/agent-evidence.json"');
    const laneSnapshot = collect.indexOf('"$SESSION_ROOT/${lane}.json"');
    const build = collect.indexOf("telegram-visible-proof.mjs collect");

    expect(cleanupStep).toBeGreaterThan(-1);
    expect(collectStep).toBeGreaterThan(cleanupStep);
    expect(collectConfig?.if).toContain("steps.cleanup.outputs.safe_to_release == 'true'");
    expect(cleanup).toContain("pkill -TERM -u codex");
    expect(cleanup).toContain("${lane}.active.json");
    expect(cleanup).toContain("${lane}.starting.json");
    expect(cleanup).toContain('"/usr/local/bin/mantis-telegram-${lane}" abort');
    expect(cleanup).toMatch(
      /kill -KILL -- "-\$lane_pgid"[\s\S]+for _ in \{1\.\.10\}[\s\S]+kill -0 -- "-\$lane_pgid"[\s\S]+Mantis lane process group remained after SIGKILL\.[\s\S]+else[\s\S]+remove_lock=true/u,
    );
    expect(snapshot).toBeGreaterThan(-1);
    expect(laneSnapshot).toBeGreaterThan(snapshot);
    expect(build).toBeGreaterThan(laneSnapshot);
    expect(collect).toContain("${RUNNER_TEMP}/mantis-trusted-evidence-");
    expect(collect).toContain("sudo install -m 0400");
  });

  it("keeps exact worktrees readable while preserving root-owned immutable revisions", () => {
    const prepare = readFileSync("scripts/mantis/telegram-visible-prepare-codex.sh", "utf8");
    const sut = readFileSync("scripts/mantis/mantis-sut-container.sh", "utf8");
    expect(prepare).toContain('sudo chmod 0755 "$worktree_root"');
    expect(sut).toContain("worktree root is not root-owned");
    expect(sut).toContain("prepared worktree is not root-owned");
    expect(sut).toContain("prepared worktree is writable");
    expect(sut).not.toContain("worktree root mode mismatch");
  });

  it("restores baseline builds only for the exact selected revision", () => {
    const restore = proofSteps().find((entry) => entry.name === "Restore exact baseline build");
    expect(restore?.with?.key).toContain("${{ needs.resolve_request.outputs.baseline_revision }}");
    expect(restore?.with).not.toHaveProperty("restore-keys");
  });

  it("retains the real userbot, isolated SUT, recorder, lease, and cleanup", () => {
    const install = readFileSync("scripts/mantis/telegram-visible-install-tools.sh", "utf8");
    const credential = readFileSync("scripts/mantis/telegram-visible-lease-user.sh", "utf8");
    const cleanup = readFileSync("scripts/mantis/telegram-visible-cleanup-proof.sh", "utf8");
    expect(install).toContain("telegram-user-driver.py");
    expect(install).toContain("telegram-desktop-recorder");
    expect(install).toContain("openclaw-mantis-sut-container");
    expect(credential).toContain("lease-restore");
    expect(credential).toContain("heartbeat-loop");
    expect(cleanup).toContain("teardown");
  });
});
