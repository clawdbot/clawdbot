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

    await expect(quiesce("/workspace")).resolves.toBeDefined();
    expect(runWorkspaceCommand).toHaveBeenCalledOnce();
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

  it("waits for an active renewal before releasing", async () => {
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
      ownerSignal: new AbortController().signal,
      sharedHost: true,
      runWorkspaceCommand,
    });
    const lease = await quiesce(String.raw`C:\Users\angry\workspace`);

    const assertion = lease.assertActive();
    await vi.waitFor(() => expect(runWorkspaceCommand).toHaveBeenCalledTimes(2));
    const release = lease.resume();
    await expect(lease.assertActive()).rejects.toThrow("already released");
    expect(runWorkspaceCommand).toHaveBeenCalledTimes(2);
    finishRenewal();
    await assertion;
    await release;

    expect(runWorkspaceCommand).toHaveBeenCalledTimes(3);
  });
});
