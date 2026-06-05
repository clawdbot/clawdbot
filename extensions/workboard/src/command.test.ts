// Workboard tests cover command plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { handleWorkboardCommand } from "./command.js";
import type { WorkboardSubagentRuntime } from "./dispatcher.js";
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
  runtime: { subagent: WorkboardSubagentRuntime };
} {
  return {
    runtime: {
      subagent: { run },
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
    const card = (await store.list())[0];
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
