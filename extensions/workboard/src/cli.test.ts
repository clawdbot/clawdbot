// Workboard tests cover cli plugin behavior.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkboardCli } from "./cli.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";

const gatewayRuntime = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
  getRuntimeConfig: vi.fn(() => ({})),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/gateway-runtime")>(
    "openclaw/plugin-sdk/gateway-runtime",
  );
  return {
    ...actual,
    callGatewayFromCli: gatewayRuntime.callGatewayFromCli,
  };
});

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: gatewayRuntime.getRuntimeConfig,
}));

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

function createProgram(store: WorkboardStore): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => {},
    writeOut: () => {},
  });
  registerWorkboardCli({ program, store });
  return program;
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

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk): boolean => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await run();
    return chunks.join("");
  } finally {
    write.mockRestore();
  }
}

describe("registerWorkboardCli", () => {
  beforeEach(() => {
    gatewayRuntime.callGatewayFromCli.mockReset();
    gatewayRuntime.getRuntimeConfig.mockReset();
    gatewayRuntime.getRuntimeConfig.mockReturnValue({});
    delete process.env.OPENCLAW_GATEWAY_URL;
  });

  it("records full-host authority on locally created cards", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const program = createProgram(store);

    await program.parseAsync(["workboard", "create", "Host card"], { from: "user" });

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          automation: expect.objectContaining({ workspaceAccess: { unrestricted: true } }),
        }),
      }),
    ]);
  });

  it("redacts claim tokens from card JSON output", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Claimed worker", status: "running" });
    await store.claim(card.id, { ownerId: "worker", token: "secret-token" });
    const program = createProgram(store);

    const listOutput = await captureStdout(async () => {
      await program.parseAsync(["workboard", "list", "--json"], { from: "user" });
    });
    const showOutput = await captureStdout(async () => {
      await program.parseAsync(["workboard", "show", card.id, "--json"], { from: "user" });
    });

    expect(listOutput).not.toContain("secret-token");
    expect(showOutput).not.toContain("secret-token");
    expect(listOutput).toContain("[redacted]");
    expect(showOutput).toContain("[redacted]");
  });

  it("hides archived cards from text output by default and reveals them with --include-archived", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.create({ title: "Active card" });
    const archived = await store.create({ title: "Archived card" });
    await store.archive(archived.id, true);
    const program = createProgram(store);

    const defaultOutput = await captureStdout(async () => {
      await program.parseAsync(["workboard", "list"], { from: "user" });
    });
    const includeOutput = await captureStdout(async () => {
      await program.parseAsync(["workboard", "list", "--include-archived"], { from: "user" });
    });

    expect(defaultOutput).toContain("Active card");
    expect(defaultOutput).not.toContain("Archived card");
    expect(includeOutput).toContain("Active card");
    expect(includeOutput).toContain("Archived card");
  });

  it("preserves archived cards in JSON list output by default", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const archived = await store.create({ title: "Archived card" });
    await store.archive(archived.id, true);
    const program = createProgram(store);

    const output = await captureStdout(async () => {
      await program.parseAsync(["workboard", "list", "--json"], { from: "user" });
    });

    expect(output).toContain(archived.id);
    expect(output).toContain("archivedAt");
  });

  it("does not fall back to local dispatch for explicit gateway targets", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Remote target", status: "ready" });
    const program = createProgram(store);
    gatewayRuntime.callGatewayFromCli.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED 127.0.0.1:18789"),
    );

    await expect(
      program.parseAsync(["workboard", "dispatch", "--url", "ws://remote"], { from: "user" }),
    ).rejects.toThrow("ECONNREFUSED");

    const after = await store.get(card.id);
    expect(after?.status).toBe("ready");
    expect(after?.metadata?.automation?.dispatchCount).toBeUndefined();
  });

  it("does not fall back to local dispatch for configured remote gateways", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Configured remote target", status: "ready" });
    const program = createProgram(store);
    gatewayRuntime.getRuntimeConfig.mockReturnValue({
      gateway: { mode: "remote", remote: { url: "wss://gateway.example" } },
    });
    gatewayRuntime.callGatewayFromCli.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED gateway.example:443"),
    );

    await expect(program.parseAsync(["workboard", "dispatch"], { from: "user" })).rejects.toThrow(
      "ECONNREFUSED",
    );

    const after = await store.get(card.id);
    expect(after?.status).toBe("ready");
    expect(after?.metadata?.automation?.dispatchCount).toBeUndefined();
  });

  it("forwards --max-starts to the dispatch gateway call", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const program = createProgram(store);
    gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce({ started: [], startFailures: [] });

    await program.parseAsync(["workboard", "dispatch", "--max-starts", "7"], { from: "user" });

    expect(gatewayRuntime.callGatewayFromCli).toHaveBeenCalledWith(
      "workboard.cards.dispatchWithOptions",
      expect.anything(),
      expect.objectContaining({ maxStarts: 7 }),
      expect.anything(),
    );
  });

  it("requests minimum scopes unless full-host access is explicit", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const program = createProgram(store);
    gatewayRuntime.callGatewayFromCli.mockResolvedValue({ started: [], startFailures: [] });

    await program.parseAsync(["workboard", "dispatch"], { from: "user" });
    expect(gatewayRuntime.callGatewayFromCli.mock.calls[0]?.[3]).toEqual({
      mode: "cli",
      scopes: ["operator.write", "operator.read"],
    });

    await program.parseAsync(["workboard", "dispatch", "--admin"], { from: "user" });
    expect(gatewayRuntime.callGatewayFromCli.mock.calls[1]?.[3]).toEqual({
      mode: "cli",
      scopes: ["operator.admin", "operator.write", "operator.read"],
    });
  });

  it("omits maxStarts from the dispatch gateway call when the flag is absent", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const program = createProgram(store);
    gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce({ started: [], startFailures: [] });

    await program.parseAsync(["workboard", "dispatch"], { from: "user" });

    const forwardedParams = gatewayRuntime.callGatewayFromCli.mock.calls[0]?.[2] as Record<
      string,
      unknown
    >;
    expect(gatewayRuntime.callGatewayFromCli.mock.calls[0]?.[0]).toBe("workboard.cards.dispatch");
    expect(forwardedParams).not.toHaveProperty("maxStarts");
  });

  it("does not fall back when an older gateway lacks max-starts dispatch", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Bounded dispatch", status: "ready" });
    const program = createProgram(store);
    gatewayRuntime.callGatewayFromCli.mockRejectedValueOnce(
      new Error("unknown method: workboard.cards.dispatchWithOptions"),
    );

    await expect(
      program.parseAsync(["workboard", "dispatch", "--max-starts", "1"], { from: "user" }),
    ).rejects.toThrow("unknown method: workboard.cards.dispatchWithOptions");

    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it.each(["0", "-1", "1e3", "0x10", "5.5"])(
    "rejects invalid --max-starts value %s",
    async (value) => {
      const store = new WorkboardStore(createMemoryStore());
      const program = createProgram(store);

      await expect(
        program.parseAsync(["workboard", "dispatch", "--max-starts", value], { from: "user" }),
      ).rejects.toThrow("--max-starts must be a positive integer.");
      expect(gatewayRuntime.callGatewayFromCli).not.toHaveBeenCalled();
    },
  );

  it("rejects ambiguous card id prefixes", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const prefix = await createAmbiguousPrefix(store);
    const program = createProgram(store);

    await expect(
      program.parseAsync(["workboard", "show", prefix], { from: "user" }),
    ).rejects.toThrow("Ambiguous card id prefix");
  });

  it("moves claimed cards with operator authority and redacts JSON output", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Claimed card", status: "todo" });
    await store.claim(card.id, { ownerId: "worker", token: "secret-token" });
    const program = createProgram(store);

    const output = await captureStdout(async () => {
      await program.parseAsync(
        ["workboard", "move", card.id.slice(0, 8), "--status", "review", "--json"],
        { from: "user" },
      );
    });

    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({ card: { id: card.id, status: "review" } });
    expect(parsed.card.metadata.claim.token).toBe("[redacted]");
    expect(output).not.toContain("secret-token");
  });

  it("rejects an invalid move status", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Invalid move" });
    const program = createProgram(store);

    await expect(
      program.parseAsync(["workboard", "move", card.id, "--status", "later"], {
        from: "user",
      }),
    ).rejects.toThrow("--status must be one of");
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "todo" });
  });
});
