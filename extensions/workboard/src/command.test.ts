// Workboard tests cover command plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { handleWorkboardCommand } from "./command.js";
import type { WorkboardSubagentRuntime, WorkboardWorktreeRuntime } from "./dispatcher.js";
import { WorkboardStore, type PersistedWorkboardCard, type WorkboardKeyedStore } from "./store.js";

function createMemoryStore<T = PersistedWorkboardCard>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
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
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

function createApi(run = vi.fn().mockResolvedValue({ runId: "run-1" })): {
  runtime: { subagent: WorkboardSubagentRuntime; worktrees: WorkboardWorktreeRuntime };
} {
  return {
    runtime: {
      subagent: { run },
      worktrees: {
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
    },
  };
}

async function createAmbiguousPrefix(store: WorkboardStore): Promise<string> {
  const seen = new Map<string, string>();
  for (let index = 0; index < 40; index += 1) {
    const card = await store.create({ title: `Card ${index}` });
    const prefix = card.id.slice(0, 1);
    if (seen.has(prefix)) {
      return prefix;
    }
    seen.set(prefix, card.id);
  }
  throw new Error("could not create cards with a shared prefix");
}

describe("handleWorkboardCommand", () => {
  it("creates, lists, and dispatches workboard cards", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = createApi();

    await expect(
      handleWorkboardCommand({
        api,
        store,
        args: "create Ship CLI",
        senderIsOwner: true,
      }),
    ).resolves.toEqual(expect.objectContaining({ text: expect.stringContaining("Ship CLI") }));
    const card = expectDefined((await store.list())[0], "created workboard card");
    expect(card).toMatchObject({ title: "Ship CLI" });

    await expect(handleWorkboardCommand({ api, store, args: "list" })).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("Ship CLI") }),
    );
    await store.update(card.id, { status: "ready" });
    await expect(
      handleWorkboardCommand({
        api,
        store,
        args: "dispatch",
        gatewayClientScopes: ["operator.write"],
      }),
    ).resolves.toEqual(expect.objectContaining({ text: expect.stringContaining("started=1") }));
    expect(api.runtime.subagent.run).toHaveBeenCalledOnce();
  });

  it("requires write access for slash mutations", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = createApi();
    const card = await store.create({ title: "Ready worker", status: "ready" });

    await expect(handleWorkboardCommand({ api, store, args: "list" })).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("Ready worker") }),
    );
    await expect(handleWorkboardCommand({ api, store, args: "create Blocked" })).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("operator.write"),
      }),
    );
    await expect(handleWorkboardCommand({ api, store, args: "dispatch" })).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("operator.write"),
      }),
    );
    expect(api.runtime.subagent.run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("requires admin scope for slash-command worktree materialization", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = createApi();
    const createWorktree = vi.mocked(api.runtime.worktrees.create);
    createWorktree.mockResolvedValue({
      id: "managed-id",
      path: "/state/worktrees/fingerprint/wb-card",
      branch: "openclaw/wb-card",
    });
    await store.create({
      title: "Denied checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo-denied" },
    });

    await expect(
      handleWorkboardCommand({
        api,
        store,
        args: "dispatch",
        gatewayClientScopes: ["operator.write"],
      }),
    ).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("operator.admin") }),
    );
    expect(createWorktree).not.toHaveBeenCalled();
    const denied = (await store.list()).find((card) => card.title === "Denied checkout");
    expect(denied).toMatchObject({ status: "ready" });
    await store.update(denied!.id, { status: "blocked" });

    const allowed = await store.create({
      title: "Allowed checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo-allowed" },
    });
    await handleWorkboardCommand({
      api,
      store,
      args: "dispatch",
      gatewayClientScopes: ["operator.admin"],
    });

    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: "/repo-allowed", ownerId: allowed.id }),
    );
  });

  it("rejects ambiguous card id prefixes", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = createApi();
    const prefix = await createAmbiguousPrefix(store);

    await expect(handleWorkboardCommand({ api, store, args: `show ${prefix}` })).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("Ambiguous card id prefix"),
      }),
    );
  });
});
