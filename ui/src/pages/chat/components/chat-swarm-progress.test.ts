/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { i18n } from "../../../i18n/index.ts";
import { pt_BR } from "../../../i18n/locales/pt-BR.ts";
import type { SessionCapability } from "../../../lib/sessions/index.ts";
import { SwarmRosterHydrator } from "../../../lib/sessions/swarm-roster.ts";
import { renderChatSwarmProgress } from "./chat-swarm-progress.ts";

const parentSessionKey = "agent:main:parent";
const parentRunId = "11111111-2222-4333-8444-555555555555";
const swarmGroupId = `swarm:${parentSessionKey}:${parentRunId}`;
const childSessionKey = "agent:main:subagent:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

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
    swarmGroupId,
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
          groupTitle: "Tarefas paralelas",
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
    expect(container.querySelector(".chat-swarm__header strong")?.textContent).toBe(
      "Tarefas paralelas",
    );
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
    expect(group?.getAttribute("data-swarm-group")).toBe(swarmGroupId);
    expect(group?.querySelector(".chat-swarm__header strong")?.textContent).toBe("Parallel tasks");
    expect(group?.textContent).not.toContain(parentRunId);
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

  it.each([
    {
      name: "explicit label",
      fields: { label: " Review CI ", displayName: "Other name" },
      expected: "Review CI",
    },
    { name: "display name", fields: { displayName: "Review CI" }, expected: "Review CI" },
    { name: "derived title", fields: { derivedTitle: "Review CI" }, expected: "Review CI" },
    { name: "unnamed child", fields: {}, expected: "Subagent:" },
    { name: "blank names", fields: { label: " ", displayName: "\t" }, expected: "Subagent:" },
    {
      name: "key-shaped names",
      fields: { label: childSessionKey, displayName: childSessionKey },
      expected: "Subagent:",
    },
  ])("names a single child from $name without exposing identifiers", ({ fields, expected }) => {
    const container = renderProgress([
      session({ key: childSessionKey, status: "running", ...fields }),
    ]);
    const heading = container.querySelector(".chat-swarm__header strong");
    expect(heading?.textContent).toBe(expected);
    expect(heading?.getAttribute("title")).toBe(expected);
    expect(container.querySelector(".chat-swarm__task-name")?.textContent).toBe(expected);
    expect(container.textContent).not.toContain(parentRunId);
    expect(container.textContent).not.toContain(childSessionKey);
    expect(container.querySelector("[data-swarm-group]")?.getAttribute("data-swarm-group")).toBe(
      swarmGroupId,
    );
  });

  it("updates the same group heading through live rows, hydration, and a second child", async () => {
    vi.useFakeTimers();
    const child = session({ key: childSessionKey, status: "running" });
    const hydrated = { ...child, label: "Review CI", updatedAt: 2 };
    let currentRows = [child];
    const hydrator = new SwarmRosterHydrator();
    const container = document.createElement("div");
    document.body.append(container);
    const params = {
      sessions: {
        canonicalListRevision: 1,
        list: vi.fn(async () => ({ sessions: [hydrated], hasMore: false })),
      } as unknown as SessionCapability,
      parentKey: parentSessionKey,
      sourceEpoch: 1,
      currentRows: () => currentRows,
      onRows: (sessions: GatewaySessionRow[]) =>
        render(renderChatSwarmProgress({ sessionKey: parentSessionKey, sessions }), container),
    };
    try {
      hydrator.update(params);
      const group = container.querySelector("[data-swarm-group]");
      expect(group?.querySelector("strong")?.textContent).toBe("Subagent:");
      await vi.runAllTimersAsync();
      expect(group?.querySelector("strong")?.textContent).toBe("Review CI");
      currentRows = [
        hydrated,
        session({ key: "agent:main:subagent:second", label: "Check types", status: "running" }),
      ];
      hydrator.update(params);
      expect(container.querySelectorAll("[data-swarm-group]")).toHaveLength(1);
      expect(group?.getAttribute("data-swarm-group")).toBe(swarmGroupId);
      expect(group?.querySelector("strong")?.textContent).toBe("Parallel tasks");
      expect(
        [...group!.querySelectorAll(".chat-swarm__task-name")].map((el) => el.textContent),
      ).toEqual(["Review CI", "Check types"]);
      expect(container.textContent).not.toContain(parentRunId);
    } finally {
      hydrator.dispose();
    }
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
