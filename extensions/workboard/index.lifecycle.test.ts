import { Command } from "commander";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

function registerGeneration() {
  const captured = capturePluginRegistration(plugin);
  const cleanup = async (
    context: Parameters<NonNullable<(typeof captured.runtimeLifecycles)[number]["cleanup"]>>[0],
  ) => {
    for (const lifecycle of captured.runtimeLifecycles) {
      await lifecycle.cleanup?.(context);
    }
  };
  const run = async (...args: string[]): Promise<unknown> => {
    const program = new Command().exitOverride();
    for (const registration of captured.cliRegistrars) {
      await registration.register({
        program,
        parentPath: [],
        config: {},
        logger: captured.api.logger,
      });
    }
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      await program.parseAsync(["workboard", ...args, "--json"], { from: "user" });
      return JSON.parse(chunks.join(""));
    } finally {
      write.mockRestore();
    }
  };
  return { cleanup, run };
}

describe("Workboard registration cleanup", () => {
  it.each(["disable", "restart"] as const)(
    "closes only the retired generation on %s",
    async (reason) => {
      await withStateDirEnv("workboard-registration-lifecycle-", async () => {
        const first = registerGeneration();
        const second = registerGeneration();
        try {
          await first.run("create", "Retained card");
          for (const context of [
            { reason: "reset" as const },
            { reason: "delete" as const },
            { reason, sessionKey: "agent:other:session" },
            { reason, runId: "other-run" },
          ]) {
            await first.cleanup(context);
            await expect(first.run("list")).resolves.toMatchObject({
              cards: [expect.objectContaining({ title: "Retained card" })],
            });
          }

          await first.cleanup({ reason });
          await expect(first.run("list")).rejects.toThrow("workboard store is closed.");
          await expect(second.run("create", "Fresh card")).resolves.toMatchObject({
            card: { title: "Fresh card" },
          });
          await expect(second.run("list")).resolves.toMatchObject({
            cards: expect.arrayContaining([
              expect.objectContaining({ title: "Retained card" }),
              expect.objectContaining({ title: "Fresh card" }),
            ]),
          });
          await first.cleanup({ reason });
        } finally {
          await first.cleanup({ reason: "disable" });
          await second.cleanup({ reason: "disable" });
        }
      });
    },
  );
});
