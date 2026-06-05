// Qa Lab tests cover coverage report plugin behavior.
import { describe, expect, it } from "vitest";
import { buildQaCoverageInventory, renderQaCoverageMarkdownReport } from "./coverage-report.js";
import { readQaScenarioPack } from "./scenario-catalog.js";

describe("qa coverage report", () => {
  it("groups scenario coverage metadata by theme and surface", () => {
    const inventory = buildQaCoverageInventory(readQaScenarioPack().scenarios);

    expect(inventory.scenarioCount).toBeGreaterThan(0);
    expect(inventory.coverageIdCount).toBeGreaterThan(0);
    expect(inventory.primaryCoverageIdCount).toBeGreaterThan(0);
    expect(inventory.secondaryCoverageIdCount).toBeGreaterThan(0);
    expect(inventory.overlappingCoverage.length).toBeGreaterThan(0);
    expect(inventory.missingCoverage).toStrictEqual([]);
    expect(inventory.liveTransportLanes.map((lane) => lane.transportId)).toEqual([
      "discord",
      "slack",
      "telegram",
      "whatsapp",
    ]);
    expect(inventory.scenarioPacks.map((pack) => pack.id)).toEqual([
      "observability",
      "personal-agent",
    ]);
    const personalPack = inventory.scenarioPacks.find((pack) => pack.id === "personal-agent");
    const observabilityPack = inventory.scenarioPacks.find((pack) => pack.id === "observability");
    expect(personalPack?.missingScenarioIds).toStrictEqual([]);
    expect(personalPack?.scenarioIds).toContain("personal-share-safe-diagnostics-artifact");
    expect(personalPack?.coverageIds).toContain("personal.redaction");
    expect(personalPack?.coverageIds).toContain("qa.artifact-safety");
    expect(observabilityPack?.missingScenarioIds).toStrictEqual([]);
    expect(observabilityPack?.scenarioIds).toEqual(["otel-trace-smoke", "docker-prometheus-smoke"]);
    expect(observabilityPack?.coverageIds).toContain("telemetry.otel");
    expect(observabilityPack?.coverageIds).toContain("telemetry.prometheus");
    expect(inventory.byTheme.memory.map((feature) => feature.id)).toContain("memory.recall");
    expect(inventory.bySurface.memory.map((feature) => feature.id)).toContain("memory.recall");
  });

  it("renders a compact markdown inventory", () => {
    const report = renderQaCoverageMarkdownReport(
      buildQaCoverageInventory(readQaScenarioPack().scenarios),
    );

    expect(report).toContain("# QA Coverage Inventory");
    expect(report).toContain("- Missing coverage metadata: 0");
    expect(report).toContain("- Overlapping coverage IDs:");
    expect(report).toContain("memory.recall");
    expect(report).toContain("primary: memory-recall (qa/scenarios/memory/memory-recall.md)");
    expect(report).toContain("secondary: active-memory-preprompt-recall");
    expect(report).toContain("## Scenario Packs");
    expect(report).toContain(
      "- personal-agent (Personal Agent Benchmark Pack): 10 scenarios; coverage:",
    );
    expect(report).toContain("- observability (Observability Smoke Pack): 2 scenarios; coverage:");
    expect(report).toContain("otel-trace-smoke, docker-prometheus-smoke");
    expect(report).toContain("personal-share-safe-diagnostics-artifact");
    expect(report).toContain("## Live Transport Lanes");
    expect(report).toContain(
      "- telegram (telegram): canary: always-on, help-command: telegram-help-command, mention-gating: telegram-mention-gating; missing baseline: allowlist-block, top-level-reply-shape, restart-resume",
    );
    expect(report).toContain("thread-follow-up: slack-thread-follow-up");
  });
});
