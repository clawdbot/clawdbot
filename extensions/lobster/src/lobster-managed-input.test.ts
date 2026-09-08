import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { createRuntimeTaskFlow } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbeddedLobsterRunner, type LobsterRunner } from "./lobster-runner.js";
import { createLobsterTool } from "./lobster-tool.js";

type BoundTaskFlow = ReturnType<ReturnType<typeof createRuntimeTaskFlow>["bindSession"]>;
type ToolResult = Awaited<ReturnType<ReturnType<typeof createLobsterTool>["execute"]>>;

const requireRecord = createRequireRecord("record", "expected-label-record");
const owner = "agent:main:managed-lobster-input";
const responseSchema = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["publish", "revise"] },
    ["__proto__"]: { type: "string", title: "Literal JSON property" },
  },
  required: ["decision"],
  additionalProperties: false,
};

let fixtureDir: string;
let closeStateDatabase: (() => void) | undefined;

async function bindFreshRuntime(sessionKey = owner) {
  const { createRuntimeTaskFlow } = await import("openclaw/plugin-sdk/plugin-test-runtime");
  const { closeOpenClawStateDatabaseForTest } =
    await import("openclaw/plugin-sdk/sqlite-runtime-testing");
  closeStateDatabase = closeOpenClawStateDatabaseForTest;
  return createRuntimeTaskFlow().bindSession({ sessionKey });
}

function createTool(taskFlow: BoundTaskFlow, runner?: LobsterRunner) {
  return createLobsterTool(createTestPluginApi({ id: "lobster" }), {
    taskFlow,
    ...(runner ? { runner } : {}),
  });
}

function flowResult(result: ToolResult) {
  const details = requireRecord(result.details, "managed Lobster result");
  const flow = requireRecord(details.flow, "managed Lobster flow");
  if (typeof flow.flowId !== "string" || typeof flow.revision !== "number") {
    throw new Error("Expected a persisted flow ID and revision");
  }
  return { details, flow, flowId: flow.flowId, revision: flow.revision };
}

async function expectRejected(operation: Promise<ToolResult>) {
  const outcome = await operation.then(
    (result) => ({ kind: "result" as const, result }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );
  if (outcome.kind === "error") {
    expect(outcome.error).toBeInstanceOf(Error);
  } else {
    expect(outcome.result).toMatchObject({ isError: true });
  }
}

async function writeWorkflow(
  options: {
    chained?: boolean;
    failAfterInput?: boolean;
    prompt?: string;
    chainedPrompt?: string;
  } = {},
) {
  const filePath = path.join(fixtureDir, "review.lobster");
  const effectsPath = path.join(fixtureDir, "effects.log");
  const scriptPath = path.join(fixtureDir, "workflow-step.cjs");
  await fs.writeFile(
    scriptPath,
    [
      "const fs = require('node:fs');",
      "const phase = process.env.PHASE;",
      "fs.appendFileSync(process.env.EFFECTS, phase + String.fromCharCode(10));",
      "if (phase === 'draft') {",
      "  process.stdout.write(JSON.stringify({text:'draft'}));",
      "} else {",
      "  if (process.env.FAIL_AFTER_INPUT === 'true') process.exit(7);",
      "  process.stdout.write(JSON.stringify({decision:process.env.DECISION,subject:process.env.SUBJECT,cwd:process.cwd()}));",
      "}",
    ].join("\n"),
    "utf8",
  );
  // File-backed scripts avoid incompatible JSON-string escaping in POSIX shells and cmd.exe.
  const run = `"${process.execPath}" "${scriptPath}"`;
  await fs.writeFile(
    filePath,
    JSON.stringify({
      steps: [
        {
          id: "draft",
          run,
          env: { EFFECTS: effectsPath, PHASE: "draft" },
        },
        {
          id: "review",
          input: {
            prompt: options.prompt ?? "Publish or revise the draft?",
            responseSchema,
            defaults: { decision: "revise" },
          },
        },
        ...(options.chained
          ? [
              {
                id: "confirmation",
                input: {
                  prompt: options.chainedPrompt ?? "Confirm?",
                  responseSchema: { type: "boolean" },
                },
              },
            ]
          : []),
        {
          id: "finish",
          run,
          env: {
            EFFECTS: effectsPath,
            PHASE: "finish",
            FAIL_AFTER_INPUT: String(Boolean(options.failAfterInput)),
            DECISION: "$review.response.decision",
            SUBJECT: "$review.subject.text",
          },
        },
      ],
    }),
    "utf8",
  );
  return { filePath, effectsPath };
}

function runParams(filePath: string) {
  return {
    action: "run",
    pipeline: filePath,
    cwd: "extensions/lobster",
    flowControllerId: "tests/lobster-input",
    flowGoal: "Review a draft without losing its pending input",
  };
}

beforeEach(async () => {
  vi.resetModules();
  fixtureDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "lobster-managed-input-")),
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixtureDir, "openclaw"));
  vi.stubEnv("LOBSTER_STATE_DIR", path.join(fixtureDir, "lobster"));
});

afterEach(async () => {
  closeStateDatabase?.();
  closeStateDatabase = undefined;
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

describe("managed Lobster structured input", () => {
  it.each(["run", "resume"] as const)(
    "stops embedded workflow effects when %s is aborted",
    async (action) => {
      const taskFlow = await bindFreshRuntime();
      const filePath = path.join(fixtureDir, "abort.lobster");
      const effectsPath = path.join(fixtureDir, "abort-effects.log");
      const scriptPath = path.join(fixtureDir, "slow-step.cjs");
      await fs.writeFile(
        scriptPath,
        [
          "const fs = require('node:fs');",
          "fs.writeFileSync(process.env.EFFECTS, 'started\\n');",
          "setTimeout(() => {",
          "  fs.appendFileSync(process.env.EFFECTS, 'finished\\n');",
          "  process.stdout.write('{}');",
          "}, 2000);",
        ].join("\n"),
      );
      await fs.writeFile(
        filePath,
        JSON.stringify({
          steps: [
            ...(action === "resume"
              ? [
                  {
                    id: "review",
                    input: { prompt: "Continue?", responseSchema: { type: "boolean" } },
                  },
                ]
              : []),
            {
              id: "slow",
              run: `"${process.execPath}" "${scriptPath}"`,
              env: { EFFECTS: effectsPath },
            },
          ],
        }),
      );
      const controller = new AbortController();
      const tool = createTool(taskFlow);
      const first =
        action === "resume"
          ? flowResult(await tool.execute("pause", runParams(filePath)))
          : undefined;
      const args = first
        ? {
            action: "resume",
            flowId: first.flowId,
            flowExpectedRevision: first.revision,
            responseJson: "true",
          }
        : runParams(filePath);
      const pending = tool.execute("abort-probe", args, controller.signal);
      await vi.waitFor(async () => {
        expect(await fs.readFile(effectsPath, "utf8")).toBe("started\n");
      });
      controller.abort(new Error("caller stopped the tool"));
      const result = await pending;
      expect(result).toMatchObject({ isError: true });
      expect(flowResult(result).flow.status).toBe("failed");
      // Wait beyond the fixture's effect deadline: an error response alone does
      // not prove that the subprocess stopped producing effects.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 2200);
      });
      expect(await fs.readFile(effectsPath, "utf8")).toBe("started\n");
    },
  );

  it("rediscovers a durable wait after reopening state and resumes without a context token", async () => {
    const { filePath, effectsPath } = await writeWorkflow();
    const taskFlow = await bindFreshRuntime();
    const first = flowResult(await createTool(taskFlow).execute("start", runParams(filePath)));
    expect(first.details.status).toBe("needs_input");
    expect(first.flow.status).toBe("waiting");
    expect(first.flow.waitJson).toMatchObject({
      kind: "lobster_input",
      prompt: "Publish or revise the draft?",
      responseSchema,
      defaults: { decision: "revise" },
      subject: { text: "draft" },
      resumeToken: expect.any(String),
      cwd: path.join(process.cwd(), "extensions/lobster"),
    });
    const wait = requireRecord(first.flow.waitJson, "persisted input wait");
    const schema = requireRecord(wait.responseSchema, "persisted input schema");
    const properties = requireRecord(schema.properties, "persisted schema properties");
    expect(Object.hasOwn(properties, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(properties, "__proto__")?.value).toEqual({
      type: "string",
      title: "Literal JSON property",
    });
    expect(taskFlow.get(first.flowId)).toEqual(first.flow);
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\n");

    // Discard the in-memory registry, not the database, before creating a new tool context.
    closeStateDatabase?.();
    vi.resetModules();
    const later = Date.now() + 30 * 24 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    const reopened = await bindFreshRuntime();
    const newTool = createTool(reopened);
    const status = flowResult(
      await newTool.execute("find-wait", { action: "status", flowId: first.flowId }),
    );
    expect(status.flow).toMatchObject({
      flowId: first.flowId,
      revision: first.revision,
      status: "waiting",
      waitJson: first.flow.waitJson,
    });
    expect(reopened.get(first.flowId)).toEqual(first.flow);
    const pending = requireRecord(
      (await newTool.execute("pending", { action: "status" })).details,
      "pending flows",
    );
    expect(pending.flows).toEqual([
      expect.objectContaining({
        flowId: first.flowId,
        revision: first.revision,
        status: "waiting",
      }),
    ]);

    const finished = flowResult(
      await newTool.execute("answer", {
        action: "resume",
        flowId: status.flowId,
        flowExpectedRevision: status.revision,
        responseJson: JSON.stringify({ decision: "publish" }),
      }),
    );
    expect(finished.details).toMatchObject({
      status: "ok",
      output: [
        {
          decision: "publish",
          subject: "draft",
          cwd: path.join(process.cwd(), "extensions/lobster"),
        },
      ],
    });
    expect(finished.flow.status).toBe("succeeded");
    expect(finished.flow.waitJson).toBeNull();
    expect(reopened.get(first.flowId)).toEqual(finished.flow);
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\nfinish\n");
  });

  it("keeps a schema-invalid answer correctable at the new revision without rerunning earlier work", async () => {
    const { filePath, effectsPath } = await writeWorkflow();
    const taskFlow = await bindFreshRuntime();
    const tool = createTool(taskFlow);
    const first = flowResult(await tool.execute("start", runParams(filePath)));
    const invalid = await tool.execute("invalid-answer", {
      action: "resume",
      flowId: first.flowId,
      flowExpectedRevision: first.revision,
      responseJson: JSON.stringify({ decision: 42 }),
    });
    expect(invalid).toMatchObject({ isError: true });
    const retry = flowResult(invalid);
    expect(retry.details.ok).toBe(false);
    expect(retry.flow.status).toBe("waiting");
    expect(retry.flow.waitJson).toEqual(first.flow.waitJson);
    expect(retry.revision).toBeGreaterThan(first.revision);
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\n");

    const corrected = flowResult(
      await createTool(await bindFreshRuntime()).execute("correct-answer", {
        action: "resume",
        flowId: retry.flowId,
        flowExpectedRevision: retry.revision,
        responseJson: JSON.stringify({ decision: "revise" }),
      }),
    );
    expect(corrected.flow.status).toBe("succeeded");
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\nfinish\n");
  });

  it("rejects foreign owners, stale revisions, substituted tokens, and terminal replay before runtime I/O", async () => {
    const { filePath } = await writeWorkflow();
    const taskFlow = await bindFreshRuntime();
    const first = flowResult(await createTool(taskFlow).execute("start", runParams(filePath)));
    const runner = { run: vi.fn<LobsterRunner["run"]>() };
    const answer = {
      action: "resume",
      flowId: first.flowId,
      flowExpectedRevision: first.revision,
      responseJson: JSON.stringify({ decision: "publish" }),
    };
    await expectRejected(
      createTool(await bindFreshRuntime("agent:main:foreign-owner"), runner).execute(
        "foreign",
        answer,
      ),
    );
    await expectRejected(
      createTool(taskFlow, runner).execute("stale", {
        ...answer,
        flowExpectedRevision: first.revision - 1,
      }),
    );
    await expectRejected(
      createTool(taskFlow, runner).execute("substitution", {
        ...answer,
        token: "unrelated-resume-token",
      }),
    );
    expect(runner.run).not.toHaveBeenCalled();
    expect(taskFlow.get(first.flowId)).toEqual(first.flow);

    const finished = flowResult(await createTool(taskFlow).execute("answer", answer));
    await expectRejected(createTool(taskFlow, runner).execute("duplicate", answer));
    await expectRejected(
      createTool(taskFlow, runner).execute("terminal", {
        ...answer,
        flowExpectedRevision: finished.revision,
      }),
    );
    expect(runner.run).not.toHaveBeenCalled();
    expect(taskFlow.get(first.flowId)).toEqual(finished.flow);
  });

  it("lets only one simultaneous answer claim and execute the checkpoint", async () => {
    const { filePath, effectsPath } = await writeWorkflow();
    const taskFlow = await bindFreshRuntime();
    const first = flowResult(await createTool(taskFlow).execute("start", runParams(filePath)));
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const embedded = createEmbeddedLobsterRunner();
    const runner = {
      run: vi.fn<LobsterRunner["run"]>(async (params) => {
        entered.resolve();
        await release.promise;
        return embedded.run(params);
      }),
    };
    const tool = createTool(taskFlow, runner);
    const answer = {
      action: "resume",
      flowId: first.flowId,
      flowExpectedRevision: first.revision,
      responseJson: JSON.stringify({ decision: "publish" }),
    };
    const winner = tool.execute("first-answer", answer);
    await entered.promise;
    try {
      await expectRejected(tool.execute("concurrent-answer", answer));
      expect(runner.run).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
    expect(flowResult(await winner).flow.status).toBe("succeeded");
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\nfinish\n");
  });

  it.each([
    { scenario: "settles a cancellation-only successor", advanceRevision: false },
    { scenario: "does not cancel a newer successor", advanceRevision: true },
  ])(
    "$scenario when cancellation arrives during runner preparation",
    async ({ advanceRevision }) => {
      const { filePath, effectsPath } = await writeWorkflow();
      const taskFlow = await bindFreshRuntime();
      const first = flowResult(await createTool(taskFlow).execute("start", runParams(filePath)));
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const embedded = createEmbeddedLobsterRunner();
      const runner = {
        run: vi.fn<LobsterRunner["run"]>(async (params) => {
          entered.resolve();
          await release.promise;
          return embedded.run(params);
        }),
      };
      const pending = createTool(taskFlow, runner).execute("answer", {
        action: "resume",
        flowId: first.flowId,
        flowExpectedRevision: first.revision,
        responseJson: JSON.stringify({ decision: "publish" }),
      });
      await entered.promise;
      let successor: ReturnType<BoundTaskFlow["get"]>;
      try {
        const claimed = taskFlow.get(first.flowId);
        expect(claimed?.status).toBe("running");
        expect(claimed?.revision).toBe(first.revision + 1);
        if (!claimed) {
          throw new Error("Expected the active managed flow claim");
        }
        const cancellation = taskFlow.requestCancel({
          flowId: first.flowId,
          expectedRevision: claimed.revision,
        });
        expect(cancellation.applied).toBe(true);
        if (!cancellation.applied) {
          throw new Error("Expected the cancellation request to be persisted");
        }
        successor = cancellation.flow;
        if (advanceRevision) {
          // A subsequent owner mutation is not the cancellation-only successor of this runner.
          const updated = taskFlow.resume({
            flowId: first.flowId,
            expectedRevision: cancellation.flow.revision,
            status: "running",
            stateJson: { successor: true },
          });
          expect(updated.applied).toBe(true);
          if (!updated.applied) {
            throw new Error("Expected the newer owner revision to be persisted");
          }
          successor = updated.flow;
        }
      } finally {
        release.resolve();
      }

      const result = await pending;
      expect(result).toMatchObject({ isError: true });
      expect(runner.run).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\n");
      if (advanceRevision) {
        expect(taskFlow.get(first.flowId)).toEqual(successor);
        expect(successor?.status).toBe("running");
      } else {
        const cancelled = flowResult(result);
        expect(cancelled.flow.status).toBe("cancelled");
        expect(taskFlow.get(first.flowId)).toEqual(cancelled.flow);
      }
    },
  );

  it("rotates chained input checkpoints and accepts a false JSON answer", async () => {
    const { filePath, effectsPath } = await writeWorkflow({ chained: true });
    const taskFlow = await bindFreshRuntime();
    const tool = createTool(taskFlow);
    const first = flowResult(await tool.execute("start", runParams(filePath)));
    const second = flowResult(
      await tool.execute("first-answer", {
        action: "resume",
        flowId: first.flowId,
        flowExpectedRevision: first.revision,
        responseJson: JSON.stringify({ decision: "publish" }),
      }),
    );
    expect(second.details.status).toBe("needs_input");
    expect(second.flow.waitJson).toMatchObject({
      kind: "lobster_input",
      prompt: "Confirm?",
      responseSchema: { type: "boolean" },
    });
    const firstWait = requireRecord(first.flow.waitJson, "first input wait");
    const secondWait = requireRecord(second.flow.waitJson, "second input wait");
    expect(secondWait.resumeToken).not.toBe(firstWait.resumeToken);
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\n");
    await expectRejected(
      tool.execute("old-answer", {
        action: "resume",
        flowId: first.flowId,
        flowExpectedRevision: first.revision,
        responseJson: JSON.stringify({ decision: "publish" }),
      }),
    );
    const finished = flowResult(
      await tool.execute("second-answer", {
        action: "resume",
        flowId: second.flowId,
        flowExpectedRevision: second.revision,
        responseJson: "false",
      }),
    );
    expect(finished.flow.status).toBe("succeeded");
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\nfinish\n");
  });

  it("cancels an input checkpoint without executing downstream work", async () => {
    const { filePath, effectsPath } = await writeWorkflow();
    const taskFlow = await bindFreshRuntime();
    const tool = createTool(taskFlow);
    const first = flowResult(await tool.execute("start", runParams(filePath)));
    const cancelled = flowResult(
      await tool.execute("cancel", {
        action: "resume",
        flowId: first.flowId,
        flowExpectedRevision: first.revision,
        cancel: true,
      }),
    );
    expect(cancelled.details.status).toBe("cancelled");
    expect(cancelled.flow.status).toBe("cancelled");
    expect(taskFlow.get(first.flowId)?.status).toBe("cancelled");
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\n");
    const wait = requireRecord(first.flow.waitJson, "cancelled input wait");
    expect(typeof wait.resumeToken).toBe("string");
    if (typeof wait.resumeToken !== "string") {
      throw new Error("Expected the cancelled checkpoint token");
    }
    // Check the dependency-owned checkpoint too; a cancelled TaskFlow alone is not cleanup proof.
    await expect(
      createEmbeddedLobsterRunner().run({
        action: "resume",
        token: wait.resumeToken,
        response: { decision: "publish" },
        cwd: path.join(process.cwd(), "extensions/lobster"),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\n");
  });

  it("records an execution failure after an input answer and never automatically replays effects", async () => {
    const { filePath, effectsPath } = await writeWorkflow({ failAfterInput: true });
    const taskFlow = await bindFreshRuntime();
    const tool = createTool(taskFlow);
    const first = flowResult(await tool.execute("start", runParams(filePath)));
    const failed = await tool.execute("answer", {
      action: "resume",
      flowId: first.flowId,
      flowExpectedRevision: first.revision,
      responseJson: JSON.stringify({ decision: "publish" }),
    });
    expect(failed).toMatchObject({ isError: true });
    const current = flowResult(failed);
    expect(current.flow.status).toBe("failed");
    expect(current.flow.waitJson).toBeNull();
    await expectRejected(
      createTool(await bindFreshRuntime()).execute("retry", {
        action: "resume",
        flowId: current.flowId,
        flowExpectedRevision: current.revision,
        responseJson: JSON.stringify({ decision: "publish" }),
      }),
    );
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\nfinish\n");
  });

  it.each(["run", "resume"] as const)(
    "persists an oversized %s checkpoint before limiting output and recovers it without replay",
    async (action) => {
      const prompt = "Review this draft? " + "p".repeat(80 * 1024);
      const { filePath, effectsPath } = await writeWorkflow(
        action === "run" ? { prompt } : { chained: true, chainedPrompt: prompt },
      );
      const taskFlow = await bindFreshRuntime();
      const tool = createTool(taskFlow);
      const firstResult = await tool.execute("start", {
        ...runParams(filePath),
        maxStdoutBytes: 16 * 1024,
        flowStateJson: JSON.stringify({ unrelatedContext: "c".repeat(100 * 1024) }),
      });
      const first = flowResult(firstResult);
      const pausedResult =
        action === "run"
          ? firstResult
          : await tool.execute("first-answer", {
              action: "resume",
              flowId: first.flowId,
              flowExpectedRevision: first.revision,
              responseJson: JSON.stringify({ decision: "publish" }),
              maxStdoutBytes: 16 * 1024,
            });
      const paused = flowResult(pausedResult);
      expect(paused.flow.status).toBe("waiting");
      expect(pausedResult).toMatchObject({ isError: true });
      expect(Buffer.byteLength(JSON.stringify(pausedResult.details, null, 2))).toBeLessThan(
        16 * 1024,
      );
      expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\n");

      closeStateDatabase?.();
      vi.resetModules();
      const reopened = await bindFreshRuntime();
      const newTool = createTool(reopened);
      const request = { action: "status", flowId: paused.flowId };
      await expect(
        newTool.execute("small-budget", { ...request, maxStdoutBytes: 16 * 1024 }),
      ).rejects.toThrow(/maxStdoutBytes/);
      const status = flowResult(
        await newTool.execute("larger-budget", {
          ...request,
          maxStdoutBytes: 128 * 1024,
        }),
      );
      expect(status.flow).not.toHaveProperty("stateJson");
      expect(requireRecord(status.flow.waitJson, "large input").prompt).toBe(prompt);
      expect(status.revision).toBe(paused.revision);
      const finished = flowResult(
        await newTool.execute("answer", {
          action: "resume",
          flowId: status.flowId,
          flowExpectedRevision: status.revision,
          responseJson: action === "run" ? JSON.stringify({ decision: "publish" }) : "false",
        }),
      );
      expect(finished.flow.status).toBe("succeeded");
      expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\nfinish\n");
    },
  );

  it("paginates all pending inputs without exposing another session's waits", async () => {
    const taskFlow = await bindFreshRuntime();
    const createdAt = Date.now();
    const ids = Array.from(
      { length: 21 },
      (_, index) =>
        taskFlow.createManaged({
          controllerId: "tests/lobster-input",
          goal: "Pending input",
          status: "waiting",
          createdAt: createdAt + index,
          waitJson: {
            kind: "lobster_input",
            prompt: "Review?",
            responseSchema,
            resumeToken: "pagination-checkpoint",
            cwd: process.cwd(),
          },
        }).flowId,
    );
    const tool = createTool(taskFlow);
    const first = requireRecord(
      (await tool.execute("first-page", { action: "status" })).details,
      "first pending page",
    );
    expect(first.nextOffset).toBe(20);
    expect(first.flows).toEqual(
      ids.slice(0, 20).map((flowId) => expect.objectContaining({ flowId })),
    );
    const second = requireRecord(
      (
        await tool.execute("second-page", {
          action: "status",
          flowOffset: first.nextOffset,
        })
      ).details,
      "second pending page",
    );
    expect(second.flows).toEqual([expect.objectContaining({ flowId: ids[20] })]);
    expect(second.nextOffset).toBeUndefined();
    const foreignTool = createTool(await bindFreshRuntime("agent:main:other-session"));
    const foreign = requireRecord(
      (await foreignTool.execute("foreign-pending", { action: "status" })).details,
      "foreign pending page",
    );
    expect(foreign.flows).toEqual([]);
    await expect(
      foreignTool.execute("foreign-detail", { action: "status", flowId: ids[0] }),
    ).rejects.toThrow(/not found/i);
  });
});
