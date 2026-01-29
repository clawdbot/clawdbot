import { Command } from "commander";
import { describe, expect, it, vi, beforeEach } from "vitest";

const callGateway = vi.fn(async () => ({}));

const runtimeLogs: string[] = [];
const runtimeErrors: string[] = [];
const defaultRuntime = {
  log: (msg: string) => runtimeLogs.push(msg),
  error: (msg: string) => runtimeErrors.push(msg),
  exit: (code: number) => {
    throw new Error(`__exit__:${code}`);
  },
};

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGateway(opts),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

describe("approve CLI", () => {
  beforeEach(() => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGateway.mockClear();
    callGateway.mockResolvedValue({});
  });

  it("resolves approval with allow-once", async () => {
    const { registerApproveCli } = await import("./approve-cli.js");
    const program = new Command();
    program.exitOverride();
    registerApproveCli(program);

    await program.parseAsync(["approve", "req-123", "allow-once"], { from: "user" });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { id: "req-123", decision: "allow-once" },
      }),
    );
    expect(runtimeLogs).toContain("✅ Exec approval allow-once submitted for req-123.");
    expect(runtimeErrors).toHaveLength(0);
  });

  it("resolves approval with allow-always", async () => {
    const { registerApproveCli } = await import("./approve-cli.js");
    const program = new Command();
    program.exitOverride();
    registerApproveCli(program);

    await program.parseAsync(["approve", "req-456", "allow-always"], { from: "user" });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { id: "req-456", decision: "allow-always" },
      }),
    );
    expect(runtimeLogs).toContain("✅ Exec approval allow-always submitted for req-456.");
  });

  it("resolves approval with deny", async () => {
    const { registerApproveCli } = await import("./approve-cli.js");
    const program = new Command();
    program.exitOverride();
    registerApproveCli(program);

    await program.parseAsync(["approve", "req-789", "deny"], { from: "user" });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { id: "req-789", decision: "deny" },
      }),
    );
    expect(runtimeLogs).toContain("✅ Exec approval deny submitted for req-789.");
  });

  it("accepts decision aliases", async () => {
    const { registerApproveCli } = await import("./approve-cli.js");
    const program = new Command();
    program.exitOverride();
    registerApproveCli(program);

    // Test "always" alias for "allow-always"
    await program.parseAsync(["approve", "req-alias", "always"], { from: "user" });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { id: "req-alias", decision: "allow-always" },
      }),
    );
  });

  it("accepts 'once' alias for allow-once", async () => {
    const { registerApproveCli } = await import("./approve-cli.js");
    const program = new Command();
    program.exitOverride();
    registerApproveCli(program);

    await program.parseAsync(["approve", "req-once", "once"], { from: "user" });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { id: "req-once", decision: "allow-once" },
      }),
    );
  });

  it("accepts 'reject' alias for deny", async () => {
    const { registerApproveCli } = await import("./approve-cli.js");
    const program = new Command();
    program.exitOverride();
    registerApproveCli(program);

    await program.parseAsync(["approve", "req-reject", "reject"], { from: "user" });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { id: "req-reject", decision: "deny" },
      }),
    );
  });

  it("rejects invalid decision", async () => {
    const { registerApproveCli } = await import("./approve-cli.js");
    const program = new Command();
    program.exitOverride();
    registerApproveCli(program);

    await expect(
      program.parseAsync(["approve", "req-bad", "invalid-decision"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(callGateway).not.toHaveBeenCalled();
    expect(runtimeErrors).toContain(
      'Invalid decision "invalid-decision". Use: allow-once, allow-always, or deny',
    );
  });

  it("handles gateway errors", async () => {
    callGateway.mockRejectedValue(new Error("Gateway timeout"));

    const { registerApproveCli } = await import("./approve-cli.js");
    const program = new Command();
    program.exitOverride();
    registerApproveCli(program);

    await expect(
      program.parseAsync(["approve", "req-fail", "allow-once"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain("❌ Failed to submit approval: Error: Gateway timeout");
  });
});
