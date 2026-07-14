import { describe, expect, it, vi } from "vitest";
import type { AuditRow } from "./broker.js";
import { registerOnePasswordCommands } from "./cli.js";
import type { OnePasswordConfig } from "./config.js";
import { MemoryKeyedStore } from "./memory-store.test-support.js";

const config: OnePasswordConfig = {
  vault: "Automation",
  defaultPolicy: "approve",
  cacheTtlSeconds: 300,
  grantTtlHours: 720,
  opTimeoutMs: 15_000,
  items: {
    alpha: { item: "Sensitive title", vault: "Automation", field: "credential", policy: "auto" },
    beta: { item: "Other", vault: "Automation", field: "credential", policy: "approve" },
    gamma: { item: "Third", vault: "Automation", field: "credential", policy: "deny" },
  },
};

type CommandAction = (options: Record<string, unknown>) => void | Promise<void>;

class TestCommand {
  private readonly children = new Map<string, TestCommand>();
  private handler: CommandAction | undefined;

  command(name: string): TestCommand {
    const key = name.split(/[ <]/u)[0] ?? name;
    const child = new TestCommand();
    this.children.set(key, child);
    return child;
  }

  description(_value: string): this {
    return this;
  }

  option(_flags: string, _description: string, _defaultValue?: string): this {
    return this;
  }

  action(fn: CommandAction): this {
    this.handler = fn;
    return this;
  }

  child(name: string): TestCommand {
    const child = this.children.get(name);
    if (!child) {
      throw new Error(`Missing test command: ${name}`);
    }
    return child;
  }

  async run(options: Record<string, unknown> = {}): Promise<void> {
    if (!this.handler) {
      throw new Error("Missing test command action");
    }
    await this.handler(options);
  }
}

function setupCommands(auditStore = new MemoryKeyedStore<AuditRow>()) {
  const program = new TestCommand();
  const write = vi.fn<(message: string) => void>();
  registerOnePasswordCommands({
    program: program as unknown as Parameters<typeof registerOnePasswordCommands>[0]["program"],
    resolveConfig: () => config,
    resolveOpClient: () => ({
      opBin: "/usr/local/bin/op",
      tokenFilePresent: async () => true,
    }),
    auditStore,
    write,
  });
  return { onepassword: program.child("onepassword"), write };
}

describe("1Password CLI output", () => {
  it("status contains readiness and counts without token or item values", async () => {
    const { onepassword, write } = setupCommands();
    await onepassword.child("status").run();
    const status = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;

    expect(status).toEqual({
      tokenFilePresent: true,
      opBinaryResolved: true,
      opBinaryPath: "/usr/local/bin/op",
      itemCount: 3,
      policyCounts: { auto: 1, approve: 1, deny: 1 },
    });
    expect(JSON.stringify(status)).not.toContain("Sensitive title");
  });

  it("audit output is deterministic, limited, truncated, and value-free", async () => {
    const store = new MemoryKeyedStore<AuditRow>();
    await store.register("first", {
      timestampMs: 1000,
      agentId: "agent-a",
      sessionKey: "session-a",
      toolCallId: "call-a",
      slug: "alpha",
      reason: "short",
      outcome: "auto",
    });
    await store.register("second", {
      timestampMs: 2000,
      agentId: "agent-b",
      sessionKey: "session-b",
      toolCallId: "call-b",
      slug: "beta",
      reason: `prefix-${"x".repeat(100)}`,
      outcome: "approved",
    });
    const { onepassword, write } = setupCommands(store);
    await onepassword.child("audit").run({ limit: "1" });
    const rows = JSON.parse(String(write.mock.calls[0]?.[0])) as Array<Record<string, unknown>>;

    expect(rows).toEqual([
      {
        timestamp: "1970-01-01T00:00:02.000Z",
        agent: "agent-b",
        slug: "beta",
        outcome: "approved",
        reason: expect.stringMatching(/^prefix-.+\.\.\.$/),
      },
    ]);
    expect(rows[0]?.reason).toHaveLength(80);
    expect(JSON.stringify(rows)).not.toContain(["fixture", "value"].join("-"));
  });

  it("preserves complete surrogate pairs at the audit reason boundary", async () => {
    const store = new MemoryKeyedStore<AuditRow>();
    await store.register("split", {
      timestampMs: 1000,
      agentId: "agent-a",
      sessionKey: "session-a",
      toolCallId: "call-a",
      slug: "alpha",
      reason: `${"x".repeat(76)}\u{1f600}tail`,
      outcome: "auto",
    });
    await store.register("fits", {
      timestampMs: 2000,
      agentId: "agent-a",
      sessionKey: "session-a",
      toolCallId: "call-b",
      slug: "alpha",
      reason: `${"x".repeat(75)}\u{1f600}tail`,
      outcome: "auto",
    });
    const { onepassword, write } = setupCommands(store);

    await onepassword.child("audit").run({ limit: "2" });
    const output = String(write.mock.calls[0]?.[0]);
    expect(output).not.toContain("\\ud83d");
    const rows = JSON.parse(output) as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.reason)).toEqual([
      `${"x".repeat(75)}\u{1f600}...`,
      `${"x".repeat(76)}...`,
    ]);
  });
});
