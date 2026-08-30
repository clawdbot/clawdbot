import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../../api/types.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { createGatewayBrowserClientFixture } from "../chat-pane.test-support.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import { deriveSubagentActivity } from "./chat-subagent-activity.ts";
import type { TaskDetailHost } from "./chat-task-detail-state.ts";
import { renderTaskDetailPanel } from "./chat-task-detail.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

function backgroundTasks(task: TaskSummary): BackgroundTasksProps {
  return {
    sessionKey: "agent:main:main",
    statusRowId: "chat-tasks-status-test",
    collapsed: false,
    narrowLayout: false,
    connected: true,
    canCancel: false,
    loading: false,
    error: null,
    tasks: [task],
    activeCount: task.status === "queued" || task.status === "running" ? 1 : 0,
    subagentActivity: deriveSubagentActivity({
      tasks: [],
      sessionKey: "agent:main:main",
      terminalObservedAtByTask: new Map(),
      canonicalizeSessionKey: (sessionKey) => sessionKey ?? "",
    }),
    taskDetails: new Map([[task.id, { ...task, prompt: "Inspect the current task." }]]),
    taskDetailErrors: new Map(),
    taskDetailLoadingIds: new Set(),
    cancellingTaskIds: new Set(),
    finishedCollapsed: false,
    onToggleCollapsed: () => undefined,
    onToggleFinished: () => undefined,
    onRefresh: () => undefined,
    onCancel: () => undefined,
  };
}

beforeEach(installTranscriptDomMocks);

afterEach(resetTranscriptTestDom);

describe("task detail panel", () => {
  it("uses the inspector for the pane's canonical session and identifies the runtime", () => {
    const task: TaskSummary = {
      id: "task-cli",
      taskId: "task-cli",
      status: "completed",
      runtime: "cli",
      agentId: "main",
      title: "Current-session command",
      sessionKey: "agent:main:main",
      terminalSummary: "Command complete",
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const request = vi.fn();
    const host: TaskDetailHost = {
      sessionKey: "main",
      client: createGatewayBrowserClientFixture({ request }),
      connected: true,
      hello: null,
    };
    const container = document.createElement("div");
    document.body.append(container);

    render(
      html`${renderTaskDetailPanel({
        backgroundTasks: backgroundTasks(task),
        chat: threadProps("pane-1"),
        host,
        task,
        transcript: createTestTranscript(),
      })}`,
      container,
    );

    const panel = container.querySelector("[data-task-detail-panel]");
    expect(panel?.textContent).toContain("Current-session command");
    expect(panel?.textContent).toContain("CLI");
    expect(panel?.textContent).toContain("Inspect the current task.");
    expect(panel?.textContent).toContain("Command complete");
    expect(panel?.textContent).not.toContain("Loading task transcript");
    expect(request).not.toHaveBeenCalled();
  });

  it("never treats a subagent's requester session as its transcript", () => {
    const task: TaskSummary = {
      id: "task-queued-subagent",
      taskId: "task-queued-subagent",
      status: "queued",
      runtime: "subagent",
      agentId: "main",
      title: "Queued child work",
      // Requester is another conversation; no child session exists yet.
      sessionKey: "agent:main:other-session",
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const request = vi.fn();
    const host: TaskDetailHost = {
      sessionKey: "main",
      client: createGatewayBrowserClientFixture({ request }),
      connected: true,
      hello: null,
    };
    const container = document.createElement("div");
    document.body.append(container);

    render(
      html`${renderTaskDetailPanel({
        backgroundTasks: backgroundTasks(task),
        chat: threadProps("pane-1"),
        host,
        task,
        transcript: createTestTranscript(),
      })}`,
      container,
    );

    const panel = container.querySelector("[data-task-detail-panel]");
    expect(panel?.textContent).toContain("Inspect the current task.");
    expect(panel?.textContent).not.toContain("Loading task transcript");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "uses qualified child session archive attribution",
      scope: "per-sender" as const,
      sessionsResultAgentId: "main",
      childRow: {
        key: "agent:work:task-child",
        kind: "direct",
        updatedAt: 2_000,
        archived: true,
        archivedAt: 2_000,
        archivedBy: { type: "human", id: "qualified-owner", label: "Qualified Owner" },
      } satisfies GatewaySessionRow,
      childSessionKey: "agent:work:task-child",
      expected: "Archived by Qualified Owner",
    },
    {
      name: "uses raw global child metadata for the owning agent",
      scope: "global" as const,
      sessionsResultAgentId: "work",
      childRow: {
        key: "global",
        kind: "global",
        updatedAt: 2_000,
        archived: true,
        archivedAt: 2_000,
        archivedBy: { type: "human", id: "global-owner", label: "Global Owner" },
      } satisfies GatewaySessionRow,
      childSessionKey: "agent:work:main",
      expected: "Archived by Global Owner",
    },
    {
      name: "rejects raw global child metadata in per-sender scope",
      scope: "per-sender" as const,
      sessionsResultAgentId: "work",
      childRow: {
        key: "global",
        kind: "global",
        updatedAt: 2_000,
        archived: true,
        archivedAt: 2_000,
        archivedBy: { type: "human", id: "per-sender-owner", label: "Per-Sender Owner" },
      } satisfies GatewaySessionRow,
      childSessionKey: "agent:work:main",
      expected: undefined,
    },
    {
      name: "rejects raw global child metadata from a different agent",
      scope: "global" as const,
      sessionsResultAgentId: "main",
      childRow: {
        key: "global",
        kind: "global",
        updatedAt: 2_000,
        archived: true,
        archivedAt: 2_000,
        archivedBy: { type: "human", id: "wrong-owner", label: "Wrong Owner" },
      } satisfies GatewaySessionRow,
      childSessionKey: "agent:work:main",
      expected: undefined,
    },
  ])("$name", async ({ scope, sessionsResultAgentId, childRow, childSessionKey, expected }) => {
    const task: TaskSummary = {
      id: "task-child",
      taskId: "task-child",
      status: "completed",
      runtime: "subagent",
      agentId: "work",
      title: "Child work",
      sessionKey: "agent:main:main",
      childSessionKey,
      createdAt: 1_000,
      updatedAt: 3_000,
    };
    const request = vi.fn(async () => ({
      messages: [
        { role: "user", content: "Before archive", timestamp: 1_000 },
        { role: "assistant", content: "After archive", timestamp: 3_000 },
      ],
    }));
    const host: TaskDetailHost = {
      sessionKey: "agent:main:main",
      client: createGatewayBrowserClientFixture({ request }),
      connected: true,
      hello: null,
      agentsList: { defaultId: "main", mainKey: "main", scope },
      sessionsResultAgentId,
    };
    const parentRow: GatewaySessionRow = {
      key: "agent:main:main",
      kind: "direct",
      updatedAt: 2_000,
      archived: true,
      archivedAt: 2_000,
      archivedBy: { type: "human", id: "parent-owner", label: "Parent Owner" },
    };
    const sessions: SessionsListResult = {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [childRow],
    };
    const chat = {
      ...threadProps("pane-1", host.sessionKey),
      selectedSession: parentRow,
      sessions,
    };
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const rerender = () => {
      render(
        html`${renderTaskDetailPanel({
          backgroundTasks: backgroundTasks(task),
          chat,
          host,
          task,
          transcript,
        })}`,
        container,
      );
      transcript.hostUpdated();
    };

    rerender();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(host.taskDetailState).toBeDefined());
    rerender();
    transcript.hostConnected();
    await flushDeferredRowPrune();

    expect(container.textContent).not.toContain("Archived by Parent Owner");
    if (expected) {
      expect(container.textContent).toContain(expected);
    } else {
      expect(container.textContent).not.toContain(`Archived by ${childRow.archivedBy.label}`);
    }
    transcript.hostDisconnected();
  });
});
