/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { renderChatSwarmProgress } from "./chat-swarm-progress.ts";

const parentSessionKey = "agent:main:parent";

type SwarmTestSession = GatewaySessionRow & {
  swarmLog?: string;
  swarmPhase?: string;
  swarmPhaseRank?: number;
};

function session(overrides: Partial<SwarmTestSession>): SwarmTestSession {
  return {
    key: "agent:main:child",
    kind: "direct",
    updatedAt: 1,
    parentSessionKey,
    swarmGroupId: "swarm:agent:main:parent:turn-42",
    ...overrides,
  };
}

function renderProgress(sessions: readonly GatewaySessionRow[]) {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderChatSwarmProgress({ sessionKey: parentSessionKey, sessions }), container);
  return container;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("chat Swarm progress", () => {
  it("groups live collector children and maps their dot states", () => {
    const container = renderProgress([
      session({
        key: "queued",
        label: "Queued child",
        status: "queued",
        hasActiveRun: true,
      }),
      session({ key: "running", label: "Running child", status: "running" }),
      session({ key: "done", label: "Done child", status: "done" }),
      session({ key: "failed", label: "Timed out child", status: "timeout" }),
      session({
        key: "finished-group",
        swarmGroupId: "swarm:agent:main:parent:finished",
        status: "done",
      }),
    ]);

    const group = container.querySelector("[data-swarm-group]");
    expect(group?.getAttribute("data-swarm-group")).toBe("swarm:agent:main:parent:turn-42");
    expect(group?.textContent).toContain("turn-42");
    expect(group?.textContent?.replace(/\s+/g, " ")).toContain("1 Running · 1 Done · 1 Failed");
    expect([...container.querySelectorAll(".chat-swarm__dot")].map((dot) => dot.className)).toEqual(
      [
        "chat-swarm__dot chat-swarm__dot--queued",
        "chat-swarm__dot chat-swarm__dot--running",
        "chat-swarm__dot chat-swarm__dot--done",
        "chat-swarm__dot chat-swarm__dot--failed",
      ],
    );
  });

  it("renders every child beyond the ordinary 50-row session page", () => {
    const container = renderProgress(
      Array.from({ length: 55 }, (_, index) =>
        session({ key: `child-${index}`, status: "running" }),
      ),
    );

    expect(container.querySelectorAll(".chat-swarm__dot")).toHaveLength(55);
  });

  it("caps historical dots while keeping active workers visible", () => {
    const container = renderProgress([
      ...Array.from({ length: 300 }, (_, index) =>
        session({ key: `done-${index}`, status: "done" }),
      ),
      session({ key: "running", status: "running" }),
    ]);

    expect(container.querySelectorAll(".chat-swarm__dot")).toHaveLength(256);
    expect(container.querySelector(".chat-swarm__dot--running")).not.toBeNull();
    expect(container.querySelector(".chat-swarm__more")?.textContent?.trim()).toBe("+45");
    expect(container.textContent?.replace(/\s+/g, " ")).toContain("1 Running · 300 Done");
  });

  it("labels dot states and disappears when no group is active", () => {
    const container = renderProgress([session({ label: "Worker A", status: "running" })]);

    const widget = container.querySelector("[data-test-id=chat-swarm]");
    const dot = container.querySelector<HTMLElement>(".chat-swarm__dot--running");
    expect(widget?.getAttribute("role")).toBe("status");
    expect(widget?.getAttribute("aria-live")).toBe("off");
    expect(dot?.title).toBe("Worker A: Running");

    render(renderChatSwarmProgress({ sessionKey: parentSessionKey, sessions: [] }), container);
    expect(container.querySelector("[data-test-id=chat-swarm]")).toBeNull();
  });

  it("buckets children by phase, labels the default bucket, and shows the latest log", () => {
    const container = renderProgress([
      session({ key: "unphased", label: "Older child", status: "running" }),
      session({ key: "planning", label: "Planner", status: "done", swarmPhase: "Plan" }),
      session({
        key: "building",
        label: "Builder",
        subagentRunState: "active",
        swarmPhase: "Build",
        swarmLog: "Implementing the selected plan.",
      }),
    ]);

    expect(
      [...container.querySelectorAll(".chat-swarm__phase")].map((phase) =>
        phase.textContent?.trim(),
      ),
    ).toEqual(["Unphased", "Plan", "Build"]);
    expect(
      [...container.querySelectorAll(".chat-swarm__phase-row")].map(
        (row) => row.querySelectorAll(".chat-swarm__dot").length,
      ),
    ).toEqual([1, 1, 1]);
    expect(container.querySelector(".chat-swarm__narrator")?.textContent).toContain(
      "Implementing the selected plan.",
    );
  });

  it("orders phase buckets by observation rank, not canonical row order", () => {
    const container = renderProgress([
      session({
        key: "builder",
        label: "Builder",
        status: "running",
        swarmPhase: "Build",
        swarmPhaseRank: 1,
      }),
      session({ key: "late-unphased", label: "Late child", status: "running" }),
      session({
        key: "planner",
        label: "Planner",
        status: "done",
        swarmPhase: "Plan",
        swarmPhaseRank: 0,
      }),
    ]);

    expect(
      [...container.querySelectorAll(".chat-swarm__phase")].map((phase) =>
        phase.textContent?.trim(),
      ),
    ).toEqual(["Plan", "Build", "Unphased"]);
  });
});
