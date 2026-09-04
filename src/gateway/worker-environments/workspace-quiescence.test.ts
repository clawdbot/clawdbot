import { describe, expect, it, vi } from "vitest";
import { createWorkerWorkspaceQuiescence } from "./workspace-quiescence.js";

describe("worker workspace quiescence", () => {
  it("preserves dedicated POSIX workspace quiescence", async () => {
    const nonce = "b".repeat(32);
    const runWorkspaceCommand = vi.fn(async () => ({
      stdout: `quiesced ${nonce}\n`,
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
    }));
    const quiesce = createWorkerWorkspaceQuiescence({
      ownerSignal: new AbortController().signal,
      sharedHost: false,
      runWorkspaceCommand,
    });

    const lease = await quiesce("/workspace");
    expect(lease).toBeDefined();
    expect(runWorkspaceCommand).toHaveBeenCalledOnce();
    await lease.resume();
  });

  it("accepts an absolute Windows workspace path", async () => {
    const nonce = "a".repeat(32);
    const runWorkspaceCommand = vi.fn(async (command: { argv: readonly string[] }) => ({
      stdout: command.argv.includes("final") ? `renewed ${nonce}\n` : `quiesced ${nonce}\n`,
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
    }));
    const quiesce = createWorkerWorkspaceQuiescence({
      ownerSignal: new AbortController().signal,
      sharedHost: true,
      runWorkspaceCommand,
    });

    const lease = await quiesce(String.raw`C:\Users\angry\workspace`);
    await lease.assertActive();
    await lease.resume();

    expect(runWorkspaceCommand).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])(
    "drains active renewal before release (owner closes: %s)",
    async (closes) => {
      const owner = new AbortController();
      const nonce = "c".repeat(32);
      let finishRenewal!: () => void;
      const renewalBlocked = new Promise<void>((resolve) => {
        finishRenewal = resolve;
      });
      const runWorkspaceCommand = vi.fn(async (command: { argv: readonly string[] }) => {
        if (command.argv.includes("final")) {
          await renewalBlocked;
          return {
            stdout: `renewed ${nonce}\n`,
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
            termination: "exit" as const,
          };
        }
        return {
          stdout: `quiesced ${nonce}\n`,
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      });
      const quiesce = createWorkerWorkspaceQuiescence({
        ownerSignal: owner.signal,
        sharedHost: true,
        runWorkspaceCommand,
      });
      const lease = await quiesce(String.raw`C:\Users\angry\workspace`);

      const assertion = lease.assertActive();
      await vi.waitFor(() => expect(runWorkspaceCommand).toHaveBeenCalledTimes(2));
      const release = lease.resume();
      await expect(lease.assertActive()).rejects.toThrow("already released");
      expect(runWorkspaceCommand).toHaveBeenCalledTimes(2);
      if (closes) {
        owner.abort();
      }
      finishRenewal();
      await assertion;
      await release;

      expect(runWorkspaceCommand).toHaveBeenCalledTimes(closes ? 2 : 3);
    },
  );

  it("releases only local renewal state when the owner closes before quiescence acknowledges", async () => {
    const owner = new AbortController();
    const runWorkspaceCommand = vi.fn(async () => {
      owner.abort();
      return {
        stdout: `quiesced ${"e".repeat(32)}\n`,
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit" as const,
      };
    });
    const lease = await createWorkerWorkspaceQuiescence({
      ownerSignal: owner.signal,
      sharedHost: true,
      runWorkspaceCommand,
    })("/workspace");

    try {
      await expect(lease.assertActive()).rejects.toThrow("already released");
    } finally {
      await Promise.all([lease.resume(), lease.resume()]);
    }
    expect(runWorkspaceCommand).toHaveBeenCalledOnce();
  });

  it.each([
    { remoteWorkspaceDir: "/workspace", sharedHost: false },
    { remoteWorkspaceDir: String.raw`C:\Users\angry\workspace`, sharedHost: true },
  ])(
    "retries a failed workspace release without duplicating concurrent attempts ($remoteWorkspaceDir)",
    async ({ remoteWorkspaceDir, sharedHost }) => {
      const nonce = "d".repeat(32);
      let releaseAttempts = 0;
      const runWorkspaceCommand = vi.fn(async (command: { argv: readonly string[] }) => {
        if (command.argv[4] === nonce && ++releaseAttempts === 1) {
          throw new Error("remote connection interrupted");
        }
        return {
          stdout: releaseAttempts === 0 ? `quiesced ${nonce}\n` : "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      });
      const lease = await createWorkerWorkspaceQuiescence({
        ownerSignal: new AbortController().signal,
        sharedHost,
        runWorkspaceCommand,
      })(remoteWorkspaceDir);

      await expect(Promise.all([lease.resume(), lease.resume()])).rejects.toThrow(
        "remote connection interrupted",
      );
      expect(releaseAttempts).toBe(1);
      await expect(lease.assertActive()).rejects.toThrow("already released");

      await expect(Promise.all([lease.resume(), lease.resume()])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(releaseAttempts).toBe(2);
      await lease.resume();
      expect(releaseAttempts).toBe(2);
    },
  );
});
