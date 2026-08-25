import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createProcessSupervisor } from "../../process/supervisor/supervisor.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { executeDeps } from "./execute-deps.js";
import { executePreparedCliRun } from "./execute.js";
import { setCliRunnerExecuteTestDeps } from "./execute.test-support.js";
import { buildCliSupervisorScopeKey } from "./helpers.js";
import type { PreparedCliRunContext } from "./types.js";

const { createChildAdapterMock } = vi.hoisted(() => ({
  createChildAdapterMock:
    vi.fn<typeof import("../../process/supervisor/adapters/child.js").createChildAdapter>(),
}));

vi.mock("../../process/supervisor/adapters/child.js", () => ({
  createChildAdapter: createChildAdapterMock,
}));

type ChildAdapter = Awaited<
  ReturnType<typeof import("../../process/supervisor/adapters/child.js").createChildAdapter>
>;

type TestAdapter = ChildAdapter & {
  emitStdout: (chunk: string) => void;
  settle: (code: number | null, signal?: NodeJS.Signals | null) => void;
};

function createTestAdapter(): TestAdapter {
  const exit = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  let stdoutListener: ((chunk: string) => void) | undefined;
  const adapter: TestAdapter = {
    pid: 1234,
    onStdout: (listener) => {
      stdoutListener = listener;
    },
    onStderr: () => {},
    wait: async () => await exit.promise,
    kill: vi.fn((signal?: NodeJS.Signals) => {
      exit.resolve({ code: null, signal: signal ?? "SIGTERM" });
    }),
    dispose: vi.fn(),
    emitStdout: (chunk) => stdoutListener?.(chunk),
    settle: (code, signal = null) => exit.resolve({ code, signal }),
  };
  return adapter;
}

function createRunContext(params: {
  runId: string;
  signal?: AbortSignal;
  beforeExecution?: () => Promise<void>;
}): PreparedCliRunContext {
  const backend = {
    command: "agent-cli",
    args: [],
    resumeArgs: ["--resume", "{sessionId}"],
    output: "text" as const,
    input: "stdin" as const,
    serialize: true,
  };

  return {
    params: {
      admittedRunContext: createTestAdmittedRunContext(params.runId),
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/openclaw-cli-cancellation-test.jsonl",
      workspaceDir: "/tmp",
      prompt: "hello",
      provider: "test-cli",
      model: "test-model",
      timeoutMs: 1_000,
      runId: params.runId,
      ...(params.signal ? { abortSignal: params.signal } : {}),
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: "test-cli",
      config: backend,
      bundleMcp: false,
    },
    preparedBackend: {
      backend,
      env: {},
      ...(params.beforeExecution ? { beforeExecution: params.beforeExecution } : {}),
    },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "test-model",
    normalizedModel: "test-model",
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    claudeSkillsPluginArgs: [],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

describe("local CLI pending process cancellation", () => {
  const restoreProcessSupervisor = executeDeps.getProcessSupervisor;
  let supervisor: ReturnType<typeof createProcessSupervisor>;

  beforeEach(() => {
    createChildAdapterMock.mockReset();
    supervisor = createProcessSupervisor();
    setCliRunnerExecuteTestDeps({ getProcessSupervisor: () => supervisor });
  });

  afterEach(() => {
    setCliRunnerExecuteTestDeps({ getProcessSupervisor: restoreProcessSupervisor });
    vi.restoreAllMocks();
  });

  it("preserves the caller run id and cleans up cancellation after normal completion", async () => {
    const controller = new AbortController();
    const adapter = createTestAdapter();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    createChildAdapterMock.mockResolvedValueOnce(adapter);

    const run = executePreparedCliRun(
      createRunContext({ runId: "cli-normal", signal: controller.signal }),
    );
    await vi.waitFor(() => {
      expect(supervisor.getRecord("cli-normal")).toMatchObject({ state: "running" });
    });
    adapter.emitStdout("completed");
    adapter.settle(0);

    await expect(run).resolves.toMatchObject({ text: "completed" });
    expect(supervisor.getRecord("cli-normal")).toMatchObject({ state: "exited" });
    const abortListener = addListener.mock.calls.find(([event]) => event === "abort")?.[1];
    expect(abortListener).toBeTypeOf("function");
    expect(removeListener).toHaveBeenCalledWith("abort", abortListener);
  });

  it("cancels a child adapter that is still starting by the caller run id", async () => {
    const controller = new AbortController();
    const startup = createDeferred<ChildAdapter>();
    const adapter = createTestAdapter();
    const cancel = vi.spyOn(supervisor, "cancel");
    createChildAdapterMock.mockReturnValueOnce(startup.promise);

    const run = executePreparedCliRun(
      createRunContext({ runId: "cli-pending", signal: controller.signal }),
    );
    await vi.waitFor(() => {
      expect(supervisor.getRecord("cli-pending")).toMatchObject({ state: "starting" });
    });

    controller.abort();
    expect(cancel).toHaveBeenCalledWith("cli-pending", "manual-cancel");
    expect(supervisor.getRecord("cli-pending")).toMatchObject({
      state: "exiting",
      terminationReason: "manual-cancel",
    });

    startup.resolve(adapter);
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(adapter.kill).toHaveBeenCalledWith("SIGTERM");
    expect(supervisor.getRecord("cli-pending")).toMatchObject({
      state: "exited",
      terminationReason: "manual-cancel",
    });
  });

  it("never starts a resumed replacement cancelled behind a real supervisor scope fence", async () => {
    const controller = new AbortController();
    const context = createRunContext({ runId: "cli-resume", signal: controller.signal });
    const scopeKey = buildCliSupervisorScopeKey({
      backend: context.preparedBackend.backend,
      backendId: context.backendResolved.id,
      cliSessionId: "resume-1",
    });
    if (!scopeKey) {
      throw new Error("Expected the resumed CLI supervisor scope");
    }

    const firstStartup = createDeferred<ChildAdapter>();
    const firstAdapter = createTestAdapter();
    const cancel = vi.spyOn(supervisor, "cancel");
    const spawn = vi.spyOn(supervisor, "spawn");
    createChildAdapterMock.mockReturnValueOnce(firstStartup.promise);

    const first = supervisor.spawn({
      runId: "cli-existing",
      sessionId: context.params.sessionId,
      backendId: context.backendResolved.id,
      scopeKey,
      mode: "child",
      argv: ["agent-cli"],
    });
    const replacement = executePreparedCliRun(context, "resume-1");

    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(supervisor.getRecord("cli-existing")).toMatchObject({ state: "starting" });
      expect(createChildAdapterMock).toHaveBeenCalledOnce();
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(supervisor.getRecord("cli-resume")).toBeUndefined();

    controller.abort();
    expect(cancel).toHaveBeenCalledWith("cli-resume", "manual-cancel");
    firstStartup.resolve(firstAdapter);

    const firstRun = await first;
    await expect(replacement).rejects.toMatchObject({ name: "AbortError" });
    expect(createChildAdapterMock).toHaveBeenCalledOnce();
    expect(firstAdapter.kill).not.toHaveBeenCalled();
    expect(supervisor.getRecord("cli-resume")).toMatchObject({
      state: "exited",
      terminationReason: "manual-cancel",
    });

    firstRun.cancel();
    await expect(firstRun.wait()).resolves.toMatchObject({ reason: "manual-cancel" });
  });

  it("does not spawn when the caller is already aborted", async () => {
    const controller = new AbortController();
    const spawn = vi.spyOn(supervisor, "spawn");
    controller.abort();

    await expect(
      executePreparedCliRun(
        createRunContext({ runId: "cli-preaborted", signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(spawn).not.toHaveBeenCalled();
    expect(createChildAdapterMock).not.toHaveBeenCalled();
  });

  it("passes plugin-owned system prompts without writing temporary files or exposing prompt argv", async () => {
    const writeCliSystemPromptFile = vi.spyOn(executeDeps, "writeCliSystemPromptFile");
    const context = createRunContext({ runId: "plugin-native-system-prompt" });
    context.preparedBackend.backend.command = "/bin/sh";
    context.preparedBackend.backend.output = "jsonl";
    context.preparedBackend.backend.jsonlDialect = "claude-stream-json";
    context.preparedBackend.backend.systemPromptFileArg = "--append-system-prompt-file";
    context.preparedBackend.backend.systemPromptArg = "--append-system-prompt";
    let executionArgs: readonly string[] | undefined;
    let executionPrompt: string | undefined;
    context.preparedBackend.execute = async function* (execution) {
      executionArgs = execution.args;
      executionPrompt = execution.systemPrompt;
      yield { type: "result", subtype: "success", result: "completed" };
    };

    await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "completed" });

    expect(executionPrompt).toBe("system");
    expect(executionArgs).not.toContain("--append-system-prompt-file");
    expect(executionArgs).not.toContain("--append-system-prompt");
    expect(writeCliSystemPromptFile).not.toHaveBeenCalled();
    expect(createChildAdapterMock).not.toHaveBeenCalled();
  });

  it("does not spawn after cancellation during asynchronous backend preparation", async () => {
    const controller = new AbortController();
    const preparation = createDeferred();
    const beforeExecution = vi.fn(async () => await preparation.promise);
    const spawn = vi.spyOn(supervisor, "spawn");
    const run = executePreparedCliRun(
      createRunContext({
        runId: "cli-preparation",
        signal: controller.signal,
        beforeExecution,
      }),
    );

    await vi.waitFor(() => expect(beforeExecution).toHaveBeenCalledOnce());
    controller.abort();
    preparation.resolve();

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(spawn).not.toHaveBeenCalled();
    expect(createChildAdapterMock).not.toHaveBeenCalled();
  });

  it("drops an aborted turn waiting behind the serialized CLI run queue", async () => {
    const firstPreparation = createDeferred();
    const beforeExecution = vi.fn(async () => await firstPreparation.promise);
    const firstAdapter = createTestAdapter();
    createChildAdapterMock.mockResolvedValueOnce(firstAdapter);

    const first = executePreparedCliRun(
      createRunContext({ runId: "cli-queue-first", beforeExecution }),
    );
    await vi.waitFor(() => expect(beforeExecution).toHaveBeenCalledOnce());

    const controller = new AbortController();
    const second = executePreparedCliRun(
      createRunContext({ runId: "cli-queue-aborted", signal: controller.signal }),
    );
    controller.abort();
    firstPreparation.resolve();

    await vi.waitFor(() => expect(createChildAdapterMock).toHaveBeenCalledOnce());
    firstAdapter.emitStdout("first");
    firstAdapter.settle(0);
    await expect(first).resolves.toMatchObject({ text: "first" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(createChildAdapterMock).toHaveBeenCalledOnce();
    expect(supervisor.getRecord("cli-queue-aborted")).toBeUndefined();
  });

  it("removes the startup abort listener when process spawning rejects", async () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const spawn = vi.spyOn(supervisor, "spawn").mockRejectedValueOnce(new Error("spawn failed"));

    await expect(
      executePreparedCliRun(
        createRunContext({ runId: "cli-spawn-rejection", signal: controller.signal }),
      ),
    ).rejects.toThrow("spawn failed");
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ runId: "cli-spawn-rejection" }));
    const abortListener = addListener.mock.calls.find(([event]) => event === "abort")?.[1];
    expect(abortListener).toBeTypeOf("function");
    expect(removeListener).toHaveBeenCalledWith("abort", abortListener);
  });
});
