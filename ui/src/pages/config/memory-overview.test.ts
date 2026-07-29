/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { DoctorMemoryStatusPayload } from "../../../../src/gateway/server-methods/doctor.ts";

// The hero derives its lobster from lobsterPetSeed, which mixes in a random
// per-load salt, so the palette (and with it sprite geometry like the sleeping
// eye peek) varies per test process. Pin a canonical look so pose assertions
// stay deterministic.
vi.mock("../../components/lobster-pet.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/lobster-pet.ts")>();
  return {
    ...actual,
    createLobsterPetLook: () =>
      actual.canonicalLobsterLook(
        expectDefined(actual.LOBSTER_PET_PALETTES[0], "canonical lobster palette"),
      ),
  };
});

import { renderMemoryOverview, type MemoryOverviewStatus } from "./memory-overview.ts";

function fixturePayload(): DoctorMemoryStatusPayload {
  const phaseBase = {
    enabled: true,
    cron: "0 3 * * *",
    managedCronPresent: true,
    nextRunAtMs: Date.now() + 60_000,
  };
  return {
    agentId: "main",
    provider: "local",
    embedding: { ok: true, checked: true },
    embeddingRuntime: {
      engine: "llama.cpp",
      state: "ready",
      backend: "metal",
      deviceNames: ["Apple GPU"],
    },
    dreaming: {
      enabled: true,
      timezone: "Europe/Vienna",
      verboseLogging: false,
      storageMode: "inline",
      separateReports: false,
      shortTermCount: 4,
      recallSignalCount: 8,
      dailySignalCount: 3,
      groundedSignalCount: 2,
      totalSignalCount: 13,
      phaseSignalCount: 7,
      lightPhaseHitCount: 5,
      remPhaseHitCount: 2,
      promotedTotal: 21,
      promotedToday: 3,
      shortTermEntries: [],
      signalEntries: [],
      promotedEntries: [],
      phases: {
        light: { ...phaseBase, lookbackDays: 7, limit: 20 },
        deep: {
          ...phaseBase,
          limit: 10,
          minScore: 0.7,
          minRecallCount: 3,
          minUniqueQueries: 2,
          recencyHalfLifeDays: 14,
        },
        rem: { ...phaseBase, lookbackDays: 30, limit: 10, minPatternStrength: 0.6 },
      },
    },
  };
}

function renderOverview(
  status: MemoryOverviewStatus,
  engineSelection: { kind: "off" } | { kind: "auto"; engineId: string } = {
    kind: "auto",
    engineId: "memory-core",
  },
) {
  const container = document.createElement("div");
  render(
    renderMemoryOverview({
      agentId: "main",
      agents: [],
      engineSelection,
      engineDisabled: false,
      status,
      onAgentChange: vi.fn(),
      onRefresh: vi.fn(),
      onNavigate: vi.fn(),
    }),
    container,
  );
  return container;
}

describe("renderMemoryOverview", () => {
  it("renders the awake reading hero and status cards from one payload", () => {
    const container = renderOverview({ kind: "ready", payload: fixturePayload() });

    expect(container.textContent).toContain("Memory is awake");
    expect(container.textContent).toContain("memory-core · hybrid search");
    expect(container.querySelector(".lob-reading-book")).not.toBeNull();
    expect(container.textContent).toContain("Sleep schedule");
    expect(container.textContent).toContain("Europe/Vienna");
    expect(container.textContent).toContain("Promoted today");
    expect(container.textContent).toContain("21");
    expect(container.textContent).toContain("Apple GPU");
  });

  it("renders a grumpy error hero with retry and no book", () => {
    const container = renderOverview({ kind: "error", message: "gateway request failed" });

    expect(container.textContent).toContain("Memory needs attention");
    expect(container.textContent).toContain("gateway request failed");
    expect(container.textContent).toContain("Retry");
    expect(container.querySelector(".lob-reading-book")).toBeNull();
  });

  it("renders the dimmed sleeping hero when the engine is off", () => {
    const container = renderOverview({ kind: "idle" }, { kind: "off" });

    expect(container.textContent).toContain("Memory is hibernating");
    expect(container.textContent).toContain("Open Settings");
    expect(container.querySelector(".memory-overview__hero--sleeping")).not.toBeNull();
    expect(container.querySelector(".lobster-pet__svg")).not.toBeNull();
    expect(container.querySelector(".lob-reading-book")).toBeNull();
  });

  it("hibernates a disabled pinned engine and points to Settings", () => {
    const container = document.createElement("div");
    render(
      renderMemoryOverview({
        agentId: "main",
        agents: [],
        engineSelection: { kind: "pinned", engineId: "memory-core" },
        engineDisabled: true,
        status: { kind: "ready", payload: fixturePayload() },
        onAgentChange: vi.fn(),
        onRefresh: vi.fn(),
        onNavigate: vi.fn(),
      }),
      container,
    );

    expect(container.textContent).toContain("Memory is hibernating");
    expect(container.textContent).toContain("selected memory engine is disabled");
    expect(container.textContent).toContain("Open Settings");
    expect(container.querySelector(".lob-reading-book")).toBeNull();
    expect(container.textContent).not.toContain("Engine health");
    expect(container.textContent).not.toContain("Sleep schedule");
  });

  it("reports every phase disabled when the global dream cycle is off", () => {
    const payload = fixturePayload();
    if (payload.dreaming) {
      payload.dreaming.enabled = false;
    }
    const container = renderOverview({ kind: "ready", payload });
    const phaseRows = [...container.querySelectorAll(".settings-row")].filter((row) =>
      /Light phase|Deep phase|REM phase/.test(row.textContent ?? ""),
    );

    expect(phaseRows).toHaveLength(3);
    expect(phaseRows.every((row) => row.textContent?.includes("Disabled"))).toBe(true);
    expect(phaseRows.every((row) => !row.textContent?.includes("next "))).toBe(true);
  });

  it("reports an enabled phase without its managed cron as not scheduled", () => {
    const payload = fixturePayload();
    if (payload.dreaming) {
      payload.dreaming.phases.light.managedCronPresent = false;
    }
    const container = renderOverview({ kind: "ready", payload });
    const lightRow = [...container.querySelectorAll(".settings-row")].find((row) =>
      row.textContent?.includes("Light phase"),
    );

    expect(lightRow?.textContent).toContain("Not scheduled");
    expect(lightRow?.textContent).not.toContain("Enabled");
    expect(lightRow?.textContent).not.toContain("next ");
  });

  it("opens the Memories tab from the overview shortcut", () => {
    const onNavigate = vi.fn();
    const container = document.createElement("div");
    render(
      renderMemoryOverview({
        agentId: "main",
        agents: [],
        engineSelection: { kind: "auto", engineId: "memory-core" },
        engineDisabled: false,
        status: { kind: "ready", payload: fixturePayload() },
        onAgentChange: vi.fn(),
        onRefresh: vi.fn(),
        onNavigate,
      }),
      container,
    );

    const shortcut = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Search memories"),
    );
    shortcut?.click();
    expect(onNavigate).toHaveBeenCalledWith("memories");
  });
});
