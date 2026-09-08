import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliBackendResolveExecutionArgsContext } from "../../plugins/cli-backend.types.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  createManagedRun,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);

afterEach(() => supervisorSpawnMock.mockReset());

describe("CLI backend resolveExecutionArgs fast mode", () => {
  it.each([true, false, "auto", undefined] as const)(
    "passes the run's fastMode=%s through to the backend context",
    async (fastMode) => {
      const resolveExecutionArgs = vi.fn((context: CliBackendResolveExecutionArgsContext) => [
        ...context.baseArgs,
      ]);
      const context = buildPreparedCliRunContext({
        provider: "codex-cli",
        model: "fixture-model",
        thinkLevel: "high",
        fastMode,
        resolveExecutionArgs,
        backend: {
          command: "/bin/sh",
          args: ["exec", "--json"],
          output: "text",
          systemPromptFileArg: undefined,
          input: "stdin",
        },
      });
      supervisorSpawnMock.mockResolvedValue(
        createManagedRun({
          reason: "exit",
          exitCode: 0,
          exitSignal: null,
          durationMs: 1,
          stdout: "done",
          stderr: "",
          timedOut: false,
          noOutputTimedOut: false,
        }),
      );

      await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "done" });

      expect(resolveExecutionArgs).toHaveBeenCalledTimes(1);
      const resolved = resolveExecutionArgs.mock.calls[0]?.[0];
      expect(resolved).toBeDefined();
      expect(resolved?.fastMode).toBe(fastMode);
      expect(resolved?.thinkingLevel).toBe("high");
      expect(resolved?.baseArgs).toEqual(["exec", "--json"]);
    },
  );
});
