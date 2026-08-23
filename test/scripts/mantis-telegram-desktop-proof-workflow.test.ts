import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/mantis-telegram-desktop-proof.yml";
const PROMPT = ".github/codex/prompts/mantis-telegram-visible-proof.md";
const HELPER = "scripts/mantis/telegram-proof-scenario.sh";
const EVENTS = "scripts/mantis/telegram-visible-proof-events.mjs";
const EVIDENCE = "scripts/mantis/telegram-visible-proof-evidence.mjs";
const DESIGN = "scripts/mantis/telegram-visible-design-scenario.sh";
const FREEZE = "scripts/mantis/telegram-visible-freeze-scenario.sh";
const REPLAY = "scripts/mantis/telegram-visible-replay-scenario.sh";
const EVALUATE = "scripts/mantis/telegram-visible-evaluate-proof.sh";
const TOOLS = "scripts/mantis/telegram-visible-install-tools.sh";
const CREDENTIAL = "scripts/mantis/telegram-visible-lease-user.sh";
const CLEANUP = "scripts/mantis/telegram-visible-cleanup-proof.sh";

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  if?: string;
};
type Workflow = {
  on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
  jobs?: Record<string, { steps?: Step[] }>;
};

function workflow() {
  return parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
}

function step(name: string) {
  const found = workflow().jobs?.run_telegram_visible_proof?.steps?.find(
    (entry) => entry.name === name,
  );
  if (!found) {
    throw new Error(`Missing step: ${name}`);
  }
  return found;
}

describe("Mantis Telegram visible proof workflow", () => {
  it("has one canonical capture path and no republish mode", () => {
    const value = workflow();
    expect(Object.keys(value.jobs ?? {})).toEqual(["resolve_request", "run_telegram_visible_proof"]);
    expect(value.on?.workflow_dispatch?.inputs).not.toHaveProperty("publish_artifact_name");
    expect(value.on?.workflow_dispatch?.inputs).not.toHaveProperty("publish_run_id");
    expect(readFileSync(WORKFLOW, "utf8")).not.toContain(
      "publish_existing_telegram_desktop_proof",
    );
  });

  it("uses GPT-5.6 once to design a scenario rather than author a verdict", () => {
    const design = readFileSync(DESIGN, "utf8");
    expect(step("Design one frozen Telegram scenario with GPT-5.6").run).toContain(DESIGN);
    expect(design).toContain("--model gpt-5.6-sol");
    expect(design).toContain("mantis-telegram-visible-proof.md");
    expect(design).not.toContain("resume --last");
    expect(readFileSync(PROMPT, "utf8")).toContain("Your only deliverable is a scenario tree");
    expect(readFileSync(PROMPT, "utf8")).not.toContain("mantis-evidence.json");
  });

  it("freezes then replays the same script against both bound revisions", () => {
    const freeze = readFileSync(FREEZE, "utf8");
    const replay = readFileSync(REPLAY, "utf8");
    expect(step("Freeze the final scenario and discard exploration").run).toContain(FREEZE);
    expect(step("Replay identical scenario on main and pull request").run).toContain(REPLAY);
    expect(freeze).toContain("telegram-visible-proof.mjs freeze");
    expect(freeze).toContain("scenario_hash");
    expect(replay).toContain("run_lane baseline");
    expect(replay).toContain("run_lane candidate");
    expect(replay.match(/bash "\$scenario\/run\.sh"/gu)).toHaveLength(1);
    expect(readFileSync(HELPER, "utf8")).not.toContain("providerRequests");
    expect(readFileSync(HELPER, "utf8")).not.toContain("botApiRequests");
  });

  it("lets trusted code alone evaluate visible events and package paired media", () => {
    const evaluate = readFileSync(EVALUATE, "utf8");
    expect(step("Evaluate only Telegram-visible evidence").run).toContain(EVALUATE);
    const events = readFileSync(EVENTS, "utf8");
    const evidence = readFileSync(EVIDENCE, "utf8");
    expect(evaluate).toContain("telegram-visible-proof.mjs evaluate");
    expect(evaluate).toContain("publish-pr-evidence.mjs");
    expect(events).toContain('new Set(["message", "edit", "edit-meta", "delete"])');
    expect(evidence).toContain("No material Telegram-visible before/after difference was proved");
    expect(evidence).not.toMatch(/providerRequests[^\n]*expectation/iu);
  });

  it("retains the real userbot, isolated SUT, recorder, lease, and cleanup boundaries", () => {
    const install = readFileSync(TOOLS, "utf8");
    const credential = readFileSync(CREDENTIAL, "utf8");
    const cleanup = readFileSync(CLEANUP, "utf8");
    expect(install).toContain("telegram-user-driver.py");
    expect(install).toContain("telegram-desktop-recorder");
    expect(install).toContain("openclaw-mantis-sut-container");
    expect(credential).toContain("lease-restore");
    expect(credential).toContain("heartbeat-loop");
    expect(cleanup).toContain("stop-lease-keepalive.sh");
    expect(cleanup).toContain("teardown");
  });

  it("deletes the old semantic compiler surface", () => {
    for (const removed of [
      ".github/codex/prompts/mantis-telegram-desktop-proof.md",
      ".github/codex/prompts/mantis-telegram-desktop-proof-resume.md",
      ".github/codex/prompts/mantis-recipes",
      "scripts/mantis/build-telegram-desktop-proof-evidence.mts",
      "test/scripts/mantis-build-telegram-desktop-proof-evidence.test.ts",
    ]) {
      expect(existsSync(removed)).toBe(false);
    }
  });
});
