import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/mantis-telegram-desktop-proof.yml";
const PROMPT = ".github/codex/prompts/mantis-telegram-visible-proof.md";

type Step = { name?: string; run?: string; env?: Record<string, string> };
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

  it("stops Codex and snapshots its judgment before trusted collection", () => {
    const collect = readFileSync("scripts/mantis/telegram-visible-collect-proof.sh", "utf8");
    const stop = collect.indexOf("pkill -TERM -u codex");
    const snapshot = collect.indexOf('install -m 0400 "$output_root/agent-evidence.json"');
    const build = collect.indexOf("telegram-visible-proof.mjs collect");
    expect(stop).toBeGreaterThan(-1);
    expect(snapshot).toBeGreaterThan(stop);
    expect(build).toBeGreaterThan(snapshot);
    expect(collect).toContain("${RUNNER_TEMP}/mantis-trusted-evidence-");
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
