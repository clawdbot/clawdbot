import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkboardCli } from "./cli.js";
import { WorkboardStore, type PersistedWorkboardCard, type WorkboardKeyedStore } from "./store.js";

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

  it("rejects ambiguous card id prefixes", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const prefix = await createAmbiguousPrefix(store);
    const program = createProgram(store);

    await expect(
      program.parseAsync(["workboard", "show", prefix], { from: "user" }),
    ).rejects.toThrow("Ambiguous card id prefix");
  });
});
