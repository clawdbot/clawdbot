import type {
  PluginHookSkillContext,
  PluginHookSkillProposalChangedEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "../../../src/plugins/hooks.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import {
  buildSkillProposalFollowupIdempotencyKey,
  captureSkillProposalFollowup,
  registerWorkboardSkillProposalObserver,
} from "./skill-proposal-observer.js";
import { WorkboardStore } from "./store.js";

function createMemoryStore(): WorkboardKeyedStore<PersistedWorkboardCard> {
  const entries = new Map<string, PersistedWorkboardCard>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].map(([key, value]) => ({ key, value }));
    },
  };
}

function proposalEvent(
  overrides: Partial<PluginHookSkillProposalChangedEvent> = {},
): PluginHookSkillProposalChangedEvent {
  return {
    eventId: "event-1",
    sequence: 1,
    action: "created",
    occurredAt: "2026-08-10T00:00:00.000Z",
    proposal: {
      id: "proposal-1",
      kind: "create",
      status: "pending",
      revision: "v1",
      revisionSha256: "sha256:revision-1",
      skillName: "github-pr-workflow",
      skillKey: "github-pr-workflow",
      skillFile: "/workspace/skills/github-pr-workflow/SKILL.md",
      source: "skill_workshop",
    },
    ...overrides,
  };
}

const ctx: PluginHookSkillContext = { workspaceDir: "/workspace", agentId: "main" };

describe("Workboard Skill Workshop proposal observer", () => {
  it("creates one idempotent follow-up from committed pending proposal events", async () => {
    const store = new WorkboardStore(createMemoryStore());

    await expect(
      captureSkillProposalFollowup({ event: proposalEvent(), ctx, store }),
    ).resolves.toEqual({ cardId: expect.any(String) });
    await expect(
      captureSkillProposalFollowup({
        event: proposalEvent({ eventId: "event-2", sequence: 2, action: "revised" }),
        ctx,
        store,
      }),
    ).resolves.toEqual({ cardId: expect.any(String) });

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        title: "Review proposed skill: github-pr-workflow",
        status: "todo",
        labels: ["skill-workshop", "proposal-review"],
        agentId: "main",
        taskId: "proposal-1",
        notes: expect.stringContaining("Proposal: proposal-1"),
        metadata: {
          automation: {
            idempotencyKey: buildSkillProposalFollowupIdempotencyKey("proposal-1"),
          },
        },
      }),
    ]);
  });

  it("ignores terminal proposal events", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const event = proposalEvent({
      action: "applied",
      proposal: { ...proposalEvent().proposal, status: "applied" },
    });

    await expect(captureSkillProposalFollowup({ event, ctx, store })).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });

  it("captures through the canonical immutable proposal-hook runner", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const on = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    registerWorkboardSkillProposalObserver({ api: { on, logger } as never, store });
    const handler = on.mock.calls[0]?.[1] as (...args: unknown[]) => unknown;
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "skill_proposal_changed", pluginId: "workboard", handler },
      ]),
    );
    const event = proposalEvent();

    await runner.runSkillProposalChanged(event, ctx);
    await runner.runSkillProposalChanged(
      proposalEvent({ eventId: "event-2", sequence: 2, action: "evaluation_completed" }),
      ctx,
    );

    await expect(store.list()).resolves.toHaveLength(1);
    expect(event.proposal.skillName).toBe("github-pr-workflow");
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("uses only the committed proposal hook and reports sanitized capture failures", async () => {
    const on = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    registerWorkboardSkillProposalObserver({
      api: { on, logger } as never,
      store: {
        create: vi.fn().mockRejectedValue(new Error("provider echoed secret proposal content")),
      },
    });

    expect(on).toHaveBeenCalledOnce();
    expect(on.mock.calls[0]?.[0]).toBe("skill_proposal_changed");
    const handler = on.mock.calls[0]?.[1] as (
      event: PluginHookSkillProposalChangedEvent,
      context: PluginHookSkillContext,
    ) => Promise<void>;
    await expect(
      handler(
        proposalEvent({
          proposal: { ...proposalEvent().proposal, skillName: "secret-skill-name" },
        }),
        ctx,
      ),
    ).resolves.toBeUndefined();

    const warning = String(logger.warn.mock.calls[0]?.[0] ?? "");
    expect(warning).toContain("error=Error");
    expect(warning).not.toContain("secret-skill-name");
    expect(warning).not.toContain("provider echoed secret proposal content");
    expect(logger.info).not.toHaveBeenCalled();
  });
});
