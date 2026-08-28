/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { i18n } from "../../../i18n/index.ts";
import { pt_BR } from "../../../i18n/locales/pt-BR.ts";
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

afterEach(async () => {
  i18n.registerTranslation("pt-BR", pt_BR);
  await i18n.setLocale("en");
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("chat Swarm progress", () => {
  it("renders completion progress from the active locale", async () => {
    i18n.registerTranslation("pt-BR", {
      labsPage: {
        swarm: {
          title: "Enxame",
          progress: "{complete} de {total}",
        },
      },
    });
    await i18n.setLocale("pt-BR");

    const container = renderProgress([
      session({ key: "running", status: "running" }),
      session({ key: "done", status: "done" }),
    ]);

    expect(
      container.querySelector(".chat-swarm__header")?.textContent?.replace(/\s+/g, " "),
    ).toContain("1 de 2");
  });

  it("groups live collector children and maps their task states", () => {
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
    expect(group?.textContent?.replace(/\s+/g, " ")).toContain("2 of 4");
    expect(
      [...container.querySelectorAll(".chat-swarm__task-icon")].map((icon) => icon.className),
    ).toEqual([
      "chat-swarm__task-icon chat-swarm__task-icon--queued",
      "chat-swarm__task-icon chat-swarm__task-icon--running",
      "chat-swarm__task-icon chat-swarm__task-icon--done",
      "chat-swarm__task-icon chat-swarm__task-icon--failed",
    ]);
  });

  it("renders every child beyond the ordinary 50-row session page", () => {
    const container = renderProgress(
      Array.from({ length: 55 }, (_, index) =>
        session({ key: `child-${index}`, status: "running" }),
      ),
    );

    expect(container.querySelectorAll(".chat-swarm__task")).toHaveLength(55);
  });

  it("caps historical tasks while keeping active workers visible", () => {
    const container = renderProgress([
      ...Array.from({ length: 300 }, (_, index) =>
        session({ key: `done-${index}`, status: "done" }),
      ),
      session({ key: "running", status: "running" }),
    ]);

    expect(container.querySelectorAll(".chat-swarm__task")).toHaveLength(256);
    expect(container.querySelector(".chat-swarm__task-icon--running")).not.toBeNull();
    expect(
      container.querySelector(".chat-swarm__header")?.textContent?.replace(/\s+/g, " "),
    ).toContain("300 of 301");
  });

  it("exposes a task list and disappears when no group is active", () => {
    const container = renderProgress([session({ label: "Worker A", status: "running" })]);

    const widget = container.querySelector("[data-test-id=chat-swarm]");
    const task = container.querySelector<HTMLElement>(".chat-swarm__task");
    expect(widget?.getAttribute("role")).toBe("status");
    expect(widget?.getAttribute("aria-live")).toBe("off");
    expect(task?.getAttribute("role")).toBe("listitem");
    expect(task?.textContent).toContain("Worker A");

    render(renderChatSwarmProgress({ sessionKey: parentSessionKey, sessions: [] }), container);
    expect(container.querySelector("[data-test-id=chat-swarm]")).toBeNull();
  });

  it("keeps registry-active terminal workers completed and hides finished groups", () => {
    const running = session({ key: "running", status: "running" });
    const completed = session({ key: "completed", status: "done", hasActiveRun: true });
    const failed = session({ key: "failed", status: "failed", hasActiveRun: true });
    const container = renderProgress([running, completed, failed]);

    expect(container.querySelectorAll(".chat-swarm__task-icon--running")).toHaveLength(1);
    expect(container.querySelectorAll(".chat-swarm__task-icon--done")).toHaveLength(1);
    expect(container.querySelectorAll(".chat-swarm__task-icon--failed")).toHaveLength(1);

    render(
      renderChatSwarmProgress({ sessionKey: parentSessionKey, sessions: [completed, failed] }),
      container,
    );
    expect(container.querySelector("[data-test-id=chat-swarm]")).toBeNull();
  });

  it("keeps tasks from every phase in the compact detail", () => {
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
      [...container.querySelectorAll(".chat-swarm__task-name")].map((task) =>
        task.textContent?.trim(),
      ),
    ).toEqual(["Older child", "Planner", "Builder"]);
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
      [...container.querySelectorAll(".chat-swarm__task-name")].map((task) =>
        task.textContent?.trim(),
      ),
    ).toEqual(["Planner", "Builder", "Late child"]);
  });

  it("uses session runtime fields instead of the last row update", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const container = renderProgress([
      session({
        key: "running",
        label: "Running",
        status: "running",
        startedAt: 90_000,
        updatedAt: 99_000,
      }),
      session({
        key: "sampled",
        label: "Sampled",
        status: "running",
        runtimeMs: 4_000,
        runtimeSampledAt: 98_000,
        updatedAt: 50_000,
      }),
      session({
        key: "done",
        label: "Done",
        status: "done",
        startedAt: 10_000,
        endedAt: 17_000,
        updatedAt: 99_999,
      }),
    ]);

    expect(
      [...container.querySelectorAll(".chat-swarm__task")].map((task) => ({
        label: task.querySelector(".chat-swarm__task-name")?.textContent,
        duration: task.querySelector(".chat-swarm__task-duration")?.textContent,
      })),
    ).toEqual([
      { label: "Running", duration: "10s" },
      { label: "Sampled", duration: "6s" },
      { label: "Done", duration: "7s" },
    ]);
  });
});
