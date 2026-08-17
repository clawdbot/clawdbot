import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkboardKeyedStore } from "./persistence-types.js";
import { createWorkboardSkillProposalReconciler } from "./skill-proposal-reconciler.js";
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

function manifest(proposals: Array<Record<string, unknown>>) {
  return {
    schema: "openclaw.skill-workshop.proposals-manifest.v1",
    updatedAt: "2026-08-10T00:00:00.000Z",
    proposals,
  };
}

function pendingProposal(id = "cli-proposal-20260810-abcdef") {
  return {
    id,
    kind: "create",
    status: "pending",
    title: "CLI proposal",
    description: "Committed before Gateway startup",
    skillName: "cli-proposal",
    skillKey: "cli-proposal",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    scanState: "clean",
  };
}

function serviceContext(logger: OpenClawPluginServiceContext["logger"]) {
  return {
    config: { agents: { list: [{ id: "main", default: true }, { id: "ops" }] } },
    stateDir: "/state",
    logger,
  } as OpenClawPluginServiceContext;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Workboard Skill Workshop proposal reconciler", () => {
  it("captures CLI-created pending proposals committed before service startup", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const request = vi
      .fn()
      .mockResolvedValueOnce(manifest([pendingProposal()]))
      .mockResolvedValueOnce(manifest([]));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const service = createWorkboardSkillProposalReconciler({
      api: { runtime: { gateway: { request } } } as never,
      store,
    });

    void service.start(serviceContext(logger));

    await vi.waitFor(async () => {
      await expect(store.list()).resolves.toHaveLength(1);
    });
    expect(request).toHaveBeenCalledWith(
      "skills.proposals.list",
      { agentId: "main" },
      { timeoutMs: 30_000, scopes: ["operator.read"] },
    );
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        title: "Review proposed skill: cli-proposal",
        agentId: "main",
        notes: expect.stringContaining("Proposal: cli-proposal-20260810-abcdef"),
      }),
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
    await service.stop?.(serviceContext(logger));
  });

  it("polls durable state and converges replayed proposals on one card", async () => {
    vi.useFakeTimers();
    const store = new WorkboardStore(createMemoryStore());
    const request = vi
      .fn()
      .mockResolvedValueOnce(manifest([]))
      .mockResolvedValueOnce(manifest([]))
      .mockResolvedValue(manifest([pendingProposal()]));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const service = createWorkboardSkillProposalReconciler({
      api: { runtime: { gateway: { request } } } as never,
      store,
    });
    void service.start(serviceContext(logger));
    await vi.advanceTimersByTimeAsync(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(store.list()).resolves.toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(6);
    await service.stop?.(serviceContext(logger));
  });

  it("continues to later agents when an earlier agent fails", async () => {
    vi.useFakeTimers();
    const store = new WorkboardStore(createMemoryStore());
    const request = vi.fn(async (_method: string, params: { agentId: string }) => {
      if (params.agentId === "main") {
        throw new Error("provider echoed secret proposal content");
      }
      return manifest([pendingProposal("ops-proposal-20260810-abcdef")]);
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const service = createWorkboardSkillProposalReconciler({
      api: { runtime: { gateway: { request } } } as never,
      store,
    });

    void service.start(serviceContext(logger));
    await vi.advanceTimersByTimeAsync(1);

    expect(request).toHaveBeenCalledTimes(2);
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        agentId: "ops",
        notes: expect.stringContaining("Proposal: ops-proposal-20260810-abcdef"),
      }),
    ]);
    const warning = String(logger.warn.mock.calls[0]?.[0] ?? "");
    expect(warning).toBe("workboard: skill proposal reconciliation failed error=Error");
    expect(warning).not.toContain("secret proposal content");
    await service.stop?.(serviceContext(logger));
  });

  it("sanitizes failures and retries on the next interval", async () => {
    vi.useFakeTimers();
    const store = new WorkboardStore(createMemoryStore());
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider echoed secret proposal content"))
      .mockResolvedValue(manifest([]));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const service = createWorkboardSkillProposalReconciler({
      api: { runtime: { gateway: { request } } } as never,
      store,
    });
    void service.start(serviceContext(logger));
    await vi.advanceTimersByTimeAsync(1);

    const warning = String(logger.warn.mock.calls[0]?.[0] ?? "");
    expect(warning).toBe("workboard: skill proposal reconciliation failed error=Error");
    expect(warning).not.toContain("secret proposal content");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(4);
    await service.stop?.(serviceContext(logger));
  });
});
