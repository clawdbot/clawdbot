/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import type { UpdateRunPhase, UpdateRunRecord } from "../../../src/infra/update-run-record.ts";
import { projectUpdateRun } from "../app/update-run-projection.ts";
import { createUpdateRunFixture as run } from "../test-helpers/update-run.ts";
import "./update-run-view.ts";

type RunViewElement = HTMLElement & {
  run: UpdateRunRecord | null;
  connected: boolean;
  updateComplete: Promise<boolean>;
};

async function mount(record: UpdateRunRecord) {
  const element = document.createElement("openclaw-update-run-view") as RunViewElement;
  element.run = record;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

afterEach(() => document.body.replaceChildren());

describe("update run projection", () => {
  it("keeps recorded failure and skipped phases distinct when a run ends early", () => {
    const view = projectUpdateRun(
      run({
        phase: "finished",
        status: "failed",
        reason: "build-failed",
        steps: [
          { step: "requested", status: "completed" },
          { step: "notice:ack", status: "completed" },
          { step: "staging", status: "completed" },
          { step: "validating", status: "failed" },
          { step: "build", status: "failed", detail: "Build failed before activation." },
        ],
      }),
    );
    expect(view.phases.map(({ step, status }) => [step, status])).toEqual([
      ["requested", "completed"],
      ["staging", "completed"],
      ["validating", "failed"],
      ["activating", "skipped"],
      ["restarting", "skipped"],
      ["verifying", "skipped"],
      ["finished", "failed"],
    ]);
    expect(view.steps).toEqual([
      { step: "build", status: "failed", detail: "Build failed before activation." },
    ]);
    expect(view.details).toBe("Build failed before activation.");
    expect(view.oracles.every((oracle) => oracle.state === "warn")).toBe(true);
  });

  it.each<UpdateRunPhase>(["requested", "staging", "validating", "verifying", "finished"])(
    "hides unused repair during %s",
    (phase) => {
      const view = projectUpdateRun(
        run({ phase, status: phase === "finished" ? "succeeded" : "running" }),
      );
      expect(view.phases.some(({ step }) => step === "repairing")).toBe(false);
    },
  );

  it.each(["in_progress", "completed", "failed", "skipped"] as const)(
    "preserves a recorded %s repair after activation",
    (status) => {
      const view = projectUpdateRun(
        run({
          phase: status === "in_progress" ? "repairing" : "finished",
          status:
            status === "in_progress" ? "running" : status === "completed" ? "succeeded" : "failed",
          steps: [
            { step: "activating", status: "completed" },
            { step: "restarting", status: "completed" },
            { step: "verifying", status: "failed" },
            { step: "repairing", status, startedAtMs: 10 },
          ],
        }),
      );
      expect(view.phases.find(({ step }) => step === "repairing")?.status).toBe(status);
      expect(view.phases.find(({ step }) => step === "activating")?.status).toBe("completed");
      expect(view.phases.find(({ step }) => step === "verifying")?.status).toBe("failed");
    },
  );

  it.each(["skipped", "unavailable"] as const)(
    "preserves %s inference as an advisory",
    (inferenceProbe) => {
      expect(projectUpdateRun(run()).oracles.every((oracle) => oracle.state === "pending")).toBe(
        true,
      );
      const view = projectUpdateRun(
        run({
          phase: "verifying",
          verification: {
            serviceRunning: true,
            versionMatch: false,
            pluginErrors: [],
            channelsReady: false,
            inferenceProbe,
          },
        }),
      );
      expect(view.oracles).toEqual([
        { name: "service", state: "pass" },
        { name: "version", state: "fail" },
        { name: "plugins", state: "pass" },
        { name: "channels", state: "fail" },
        { name: "inference", state: "warn" },
      ]);
      expect(
        projectUpdateRun(
          run({ verification: { pluginErrors: ["Load failed"], inferenceProbe: "failed" } }),
        )
          .oracles.filter((oracle) => oracle.state === "fail")
          .map((oracle) => oracle.name),
      ).toEqual(["plugins", "inference"]);
    },
  );

  it("selects live details ahead of a later completed step and bounds the visible tail", () => {
    const view = projectUpdateRun(
      run({
        steps: [
          {
            step: "install",
            status: "in_progress",
            detail: Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"),
          },
          { step: "preflight", status: "completed", detail: "Earlier preflight." },
        ],
      }),
    );
    expect(view.detailStep).toBe("install");
    expect(view.details.split("\n")).toHaveLength(80);
    expect(view.details.startsWith("line 20\n")).toBe(true);
    expect(view.details.endsWith("line 99")).toBe(true);
  });
});

describe("update run view", () => {
  it("keeps the view mounted across a restart and replaces progress with a visible success report", async () => {
    const element = await mount(run({ phase: "restarting" }));
    const container = element.querySelector(".update-run-view");
    element.connected = false;
    await element.updateComplete;
    expect(element.querySelector("h3")?.textContent).toBe("Gateway restarting…");
    expect(element.querySelector('[aria-label="Update report"]')).toBeNull();
    element.connected = true;
    element.run = run({
      phase: "verifying",
      verification: { serviceRunning: true, versionMatch: true },
    });
    await element.updateComplete;
    expect(element.querySelector(".update-run-view")).toBe(container);
    expect(element.querySelector("h3")?.textContent).toContain("verifying");
    element.run = run({
      phase: "finished",
      status: "succeeded",
      finishedAtMs: 30,
      after: { version: "2026.9.2" },
      verification: {
        serviceRunning: true,
        versionMatch: true,
        channelsReady: true,
        pluginErrors: [],
        inferenceProbe: "passed",
      },
      steps: [
        { step: "staging", status: "completed" },
        { step: "verifying", status: "completed" },
      ],
    });
    await element.updateComplete;
    const report = element.querySelector('[aria-label="Update report"]');
    expect(report?.textContent).toContain("✅ OpenClaw updated to 2026.9.2 (from 2026.9.1).");
    expect(report?.textContent).toContain(
      "service running; version verified; channels ready; inference passed",
    );
    expect(element.querySelectorAll('[data-state="pass"]')).toHaveLength(5);
    expect(element.querySelector('[data-step="repairing"]')).toBeNull();
  });

  it("shows failure details and report text without interpreting diagnostic markup", async () => {
    const element = await mount(
      run({
        status: "failed",
        phase: "finished",
        reason: "build-failed",
        steps: [
          {
            step: "build",
            status: "failed",
            detail: '<img src=x onerror="alert(1)"> compilation failed',
          },
        ],
      }),
    );
    expect(element.querySelector('[aria-label="Update report"]')?.textContent).toContain(
      "Run openclaw triage to diagnose and repair the failed update.",
    );
    expect(element.querySelector(".update-run-view__details")?.textContent).toContain(
      '<img src=x onerror="alert(1)">',
    );
    expect(element.querySelector("img")).toBeNull();
    expect(element.querySelector('[data-step="build"]')?.getAttribute("aria-label")).toBe(
      "build: Failed",
    );
  });
});
