import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
} from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.ts";

const sessionKey = "agent:main:attention";

function setRows(
  harness: ReturnType<typeof createSessionsHarness>,
  rows: GatewaySessionRow[],
): void {
  harness.publishList({
    result: {
      ts: 2,
      path: "",
      count: rows.length,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: rows,
    } satisfies SessionsListResult,
  });
}

function failedRow(
  key = sessionKey,
  overrides: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    label: "Blocked investigation",
    updatedAt: 2,
    endedAt: 2,
    status: "failed",
    lastRunError: "Provider credits exhausted",
    ...overrides,
  };
}

describe("AppSidebar session attention", () => {
  it("shows question attention ahead of a run error and clears it on resolution", async () => {
    const client = {
      request: vi.fn().mockResolvedValue({ questions: [] }),
    } as unknown as GatewayBrowserClient;
    const gatewayHarness = createGatewayHarness(client);
    const sessionsHarness = createSessionsHarness("main", [sessionKey]);
    setRows(sessionsHarness, [failedRow()]);
    const { sidebar } = await mountSidebar(gatewayHarness.gateway, sessionsHarness.sessions);

    gatewayHarness.publishEvent("question.requested", {
      id: "question-1",
      agentId: "main",
      sessionKey,
      questions: [
        {
          questionId: "confirm",
          header: "Confirm",
          question: "Continue?",
          options: [{ label: "Continue", description: "Resume the run." }],
        },
      ],
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      status: "pending",
    });
    await sidebar.updateComplete;

    expect(sidebar.querySelector('[data-session-attention="question"]')).not.toBeNull();
    expect(sidebar.textContent).toContain("Waiting for your answer");
    expect(sidebar.textContent).not.toContain("Run failed:");

    gatewayHarness.publishEvent("question.resolved", {
      id: "question-1",
      status: "cancelled",
    });
    await sidebar.updateComplete;
    expect(sidebar.querySelector('[data-session-attention="question"]')).toBeNull();
    expect(sidebar.querySelector('[data-session-attention="error"]')).not.toBeNull();
  });

  it("shows approval attention ahead of a run error", async () => {
    const approval = {
      id: "approval-1",
      kind: "exec",
      request: { command: "git status", sessionKey },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    } satisfies ExecApprovalRequest;
    const sessionsHarness = createSessionsHarness("main", [sessionKey]);
    setRows(sessionsHarness, [failedRow()]);
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      sessionsHarness.sessions,
      "panel",
      null,
      [approval],
    );

    expect(sidebar.querySelector('[data-session-attention="approval"]')).not.toBeNull();
    expect(sidebar.textContent).toContain("Waiting for approval");
    expect(sidebar.textContent).not.toContain("Run failed:");
  });

  it("shows an error icon and reason for an unread failure", async () => {
    const sessionsHarness = createSessionsHarness("main", [sessionKey]);
    setRows(sessionsHarness, [failedRow()]);
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      sessionsHarness.sessions,
    );
    await sidebar.updateComplete;

    expect(sidebar.querySelector('[data-session-attention="error"]')).not.toBeNull();
    expect(sidebar.textContent).toContain("Run failed: Provider credits exhausted");
  });

  it("keeps a read failure dismissed after the sessions list refreshes", async () => {
    const sessionsHarness = createSessionsHarness("main", [sessionKey]);
    setRows(sessionsHarness, [failedRow()]);
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      sessionsHarness.sessions,
    );

    expect(sidebar.querySelector('[data-session-attention="error"]')).not.toBeNull();
    setRows(sessionsHarness, [failedRow(sessionKey, { lastReadAt: 2 })]);
    await sidebar.updateComplete;

    expect(sidebar.querySelector('[data-session-attention="error"]')).toBeNull();
    expect(sidebar.textContent).not.toContain("Run failed:");
  });

  it("shows attention again when a later failure follows a read", async () => {
    const sessionsHarness = createSessionsHarness("main", [sessionKey]);
    setRows(sessionsHarness, [failedRow(sessionKey, { lastReadAt: 2 })]);
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      sessionsHarness.sessions,
    );

    expect(sidebar.querySelector('[data-session-attention="error"]')).toBeNull();
    setRows(sessionsHarness, [failedRow(sessionKey, { endedAt: 3, updatedAt: 3, lastReadAt: 2 })]);
    await sidebar.updateComplete;

    expect(sidebar.querySelector('[data-session-attention="error"]')).not.toBeNull();
    expect(sidebar.textContent).toContain("Run failed: Provider credits exhausted");
  });

  it("marks a collapsed section that contains an attention session", async () => {
    localStorage.setItem(
      "openclaw:sidebar:sessions:collapsed-sections",
      JSON.stringify(["ungrouped"]),
    );
    const sessionsHarness = createSessionsHarness("main", [sessionKey]);
    setRows(sessionsHarness, [failedRow()]);
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      sessionsHarness.sessions,
    );

    const section = sidebar.querySelector('[data-session-section="ungrouped"]');
    expect(section?.querySelector(".sidebar-session-group-attention")).not.toBeNull();
    expect(section?.querySelector(".sidebar-recent-session")).toBeNull();
  });

  it("bubbles an unloaded child's pending question to its parent and collapsed section", async () => {
    const parentKey = "agent:main:parent";
    const childKey = "agent:main:subagent:question";
    const client = {
      request: vi.fn().mockResolvedValue({ questions: [] }),
    } as unknown as GatewayBrowserClient;
    const gatewayHarness = createGatewayHarness(client);
    const sessionsHarness = createSessionsHarness("main", [parentKey]);
    setRows(sessionsHarness, [
      {
        key: parentKey,
        kind: "direct",
        label: "Parent task",
        updatedAt: 1,
        childSessions: [childKey],
      },
    ]);
    const { sidebar } = await mountSidebar(gatewayHarness.gateway, sessionsHarness.sessions);

    gatewayHarness.publishEvent("question.requested", {
      id: "question-child",
      agentId: "main",
      sessionKey: childKey,
      questions: [{ questionId: "confirm", header: "Confirm", question: "Continue?", options: [] }],
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      status: "pending",
    });
    await sidebar.updateComplete;

    expect(
      sidebar.querySelector(
        `[data-session-key="${parentKey}"] [data-session-attention="question"]`,
      ),
    ).not.toBeNull();
    expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).toBeNull();
    sidebar.querySelector<HTMLButtonElement>(".sidebar-session-group-toggle")?.click();
    await sidebar.updateComplete;
    expect(
      sidebar
        .querySelector('[data-session-section="ungrouped"]')
        ?.querySelector(".sidebar-session-group-attention"),
    ).not.toBeNull();
  });

  it("bubbles an unloaded child's pending approval to its parent and collapsed section", async () => {
    const parentKey = "agent:main:parent";
    const childKey = "agent:main:subagent:approval";
    const approval = {
      id: "approval-child",
      kind: "exec",
      request: { command: "git status", sessionKey: childKey },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    } satisfies ExecApprovalRequest;
    const sessionsHarness = createSessionsHarness("main", [parentKey]);
    setRows(sessionsHarness, [
      {
        key: parentKey,
        kind: "direct",
        label: "Parent task",
        updatedAt: 1,
        childSessions: [childKey],
      },
    ]);
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      sessionsHarness.sessions,
      "panel",
      null,
      [approval],
    );

    expect(
      sidebar.querySelector(
        `[data-session-key="${parentKey}"] [data-session-attention="approval"]`,
      ),
    ).not.toBeNull();
    expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).toBeNull();
    sidebar.querySelector<HTMLButtonElement>(".sidebar-session-group-toggle")?.click();
    await sidebar.updateComplete;
    expect(
      sidebar
        .querySelector('[data-session-section="ungrouped"]')
        ?.querySelector(".sidebar-session-group-attention"),
    ).not.toBeNull();
  });

  it("bubbles descendant attention and keeps its branch visible past the child cap", async () => {
    const parentKey = "agent:main:parent";
    const childKeys = Array.from(
      { length: 6 },
      (_, index) => `agent:main:subagent:child-${index + 1}`,
    );
    const sessionsHarness = createSessionsHarness("main", [parentKey]);
    sessionsHarness.list.mockResolvedValue({
      ts: 3,
      path: "",
      count: childKeys.length,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: childKeys.map((key, index) =>
        index === 5
          ? { ...failedRow(key), spawnedBy: parentKey, label: "Attention child" }
          : {
              key,
              spawnedBy: parentKey,
              kind: "direct" as const,
              label: `Quiet child ${index + 1}`,
              updatedAt: index + 1,
            },
      ),
    });
    setRows(sessionsHarness, [
      {
        key: parentKey,
        kind: "direct",
        label: "Parent task",
        updatedAt: 1,
        childSessions: childKeys,
      },
    ]);
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      sessionsHarness.sessions,
    );

    sidebar.querySelector<HTMLButtonElement>(`[data-child-session-toggle="${parentKey}"]`)?.click();
    await waitForFast(() => {
      expect(
        sidebar.querySelector(`[data-session-key="${parentKey}"] [data-session-attention="error"]`),
      ).not.toBeNull();
      expect(sidebar.querySelector(`[data-session-key="${childKeys[5]}"]`)).not.toBeNull();
    });
    expect(sidebar.querySelector(`[data-session-key="${childKeys[4]}"]`)).toBeNull();
    expect(sidebar.querySelector("[data-show-more-children]")?.textContent?.trim()).toBe(
      "Show 1 more",
    );
  });
});
