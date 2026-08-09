import type {
  PluginHookSkillContext,
  PluginHookSkillProposalChangedEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import type { WorkboardKeyedStore } from "./persistence-types.js";
import { createWorkboardSkillProposalHandler } from "./skill-proposal-observer.js";
import { WorkboardStore } from "./store.js";

function createMemoryStore(): WorkboardKeyedStore {
  const entries = new Map<string, Parameters<WorkboardKeyedStore["register"]>[1]>();
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
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const handler = createWorkboardSkillProposalHandler({ api: { logger }, store });

    const actions = ["created", "revised", "evaluation_completed"] as const;
    for (const [index, action] of actions.entries()) {
      const sequence = index + 1;
      await handler(proposalEvent({ eventId: `event-${sequence}`, sequence, action }), ctx);
    }

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
            idempotencyKey: expect.stringMatching(/^skill-workshop-proposal-v1:[a-f0-9]{32}$/),
          },
        },
      }),
    ]);
    expect(logger.info).toHaveBeenCalledTimes(3);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("ignores terminal proposal events", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const handler = createWorkboardSkillProposalHandler({ api: { logger }, store });
    const event = proposalEvent({
      action: "applied",
      proposal: { ...proposalEvent().proposal, status: "applied" },
    });

    await expect(handler(event, ctx)).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reports sanitized capture failures", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const handler = createWorkboardSkillProposalHandler({
      api: { logger },
      store: {
        create: vi.fn().mockRejectedValue(new Error("provider echoed secret proposal content")),
      },
    });

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
