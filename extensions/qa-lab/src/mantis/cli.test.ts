import { Command } from "commander";
import { expect, it, vi } from "vitest";
import type { MantisBeforeAfterOptions } from "./run.runtime.js";

const { runMantisBeforeAfterCommand } = vi.hoisted(() => ({
  runMantisBeforeAfterCommand: vi.fn<(opts: MantisBeforeAfterOptions) => Promise<void>>(),
}));

vi.mock("./cli.runtime.js", () => ({
  runMantisBeforeAfterCommand,
}));

vi.mock("../live-transports/shared/live-transport-cli.js", () => ({
  createLazyCliRuntimeLoader:
    <T>(load: () => Promise<T>) =>
    async () =>
      await load(),
}));

import { registerMantisCli } from "./cli.js";

const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM"] as const;

it.each([
  { exitCode: 130, signal: "SIGINT" },
  { exitCode: 143, signal: "SIGTERM" },
] as const)(
  "aborts a Mantis run and preserves the $signal exit outcome",
  async ({ exitCode, signal }) => {
    const program = new Command();
    registerMantisCli(program.command("qa"));
    const listenersBefore = new Map(
      INTERRUPT_SIGNALS.map((name) => [name, new Set(process.listeners(name))]),
    );
    const previousExitCode = process.exitCode;
    let cleanupComplete = false;
    let resolveStarted: ((value: AbortSignal) => void) | undefined;
    const started = new Promise<AbortSignal>((resolve) => {
      resolveStarted = resolve;
    });
    runMantisBeforeAfterCommand.mockImplementationOnce(async (opts) => {
      const runtimeSignal = opts.signal;
      if (!runtimeSignal) {
        throw new Error("expected the Mantis CLI to pass an AbortSignal");
      }
      resolveStarted?.(runtimeSignal);
      await new Promise<void>((resolve) => {
        runtimeSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      cleanupComplete = true;
      throw runtimeSignal.reason;
    });

    process.exitCode = undefined;
    try {
      const command = program.parseAsync([
        "node",
        "openclaw",
        "qa",
        "mantis",
        "run",
        "--transport",
        "discord",
        "--scenario",
        "discord-status-reactions-tool-only",
        "--baseline",
        "origin/main",
        "--candidate",
        "HEAD",
      ]);
      const runtimeSignal = await started;
      const signalHandler = process
        .listeners(signal)
        .find((listener) => !listenersBefore.get(signal)?.has(listener));
      expect(signalHandler).toBeDefined();

      signalHandler?.(signal);
      await command;

      expect(runtimeSignal.aborted).toBe(true);
      expect(cleanupComplete).toBe(true);
      expect(process.exitCode).toBe(exitCode);
      for (const name of INTERRUPT_SIGNALS) {
        expect(new Set(process.listeners(name))).toEqual(listenersBefore.get(name));
      }
    } finally {
      process.exitCode = previousExitCode;
    }
  },
);
