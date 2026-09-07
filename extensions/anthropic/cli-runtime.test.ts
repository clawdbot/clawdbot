import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
  CliBackendPreparedExecution,
  CliBackendToolPermissionResult,
} from "openclaw/plugin-sdk/cli-backend";
import { formatErrorMessageForDisplay } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import type { ClaudeCliSecretInput } from "./cli-process.js";
import { CLAUDE_PROTOCOL_FIXTURE } from "./cli-runtime.test-support.js";
import { executeClaudeCli } from "./cli.runtime.js";

const roots: string[] = [];
const handles = new Set<CliBackendLiveSessionHandle>();

afterEach(async () => {
  for (const handle of handles) {
    handle.close("restart");
    await handle.waitForExit();
  }
  handles.clear();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createContext(
  scenario = "normal",
  overrides: Partial<CliBackendExecuteContext> = {},
): Promise<CliBackendExecuteContext> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-protocol-")));
  roots.push(root);
  const fixture = path.join(root, "claude.mjs");
  await writeFile(fixture, CLAUDE_PROTOCOL_FIXTURE);
  return {
    command: process.execPath,
    args: [fixture],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      CLAUDE_CONFIG_DIR: root,
      CLAUDE_FIXTURE_SCENARIO: scenario,
    },
    prompt: "synthetic user input",
    systemPrompt: "synthetic operator instructions",
    modelId: "claude-sonnet-4-6",
    useResume: false,
    timeoutMs: 10_000,
    abortSignal: AbortSignal.timeout(10_000),
    requestToolPermission: vi.fn<CliBackendExecuteContext["requestToolPermission"]>(async () => ({
      behavior: "deny",
      message: "Fixture denied.",
    })),
    requestUserInput: vi.fn<CliBackendExecuteContext["requestUserInput"]>(async () => ({
      status: "cancelled",
      message: "No question expected.",
    })),
    ...overrides,
  };
}

function createLiveSession(cleanup?: () => Promise<void>): CliBackendLiveSessionCapability {
  let current: CliBackendLiveSessionHandle | undefined;
  let retiredCleanup: Promise<void> | undefined;
  return {
    fingerprint: "synthetic-process-policy",
    current: () => current,
    restart: async () => {
      const previous = current;
      previous?.close("restart");
      await previous?.waitForExit();
      await retiredCleanup;
    },
    register: (handle) => {
      if (retiredCleanup) {
        throw new Error("Previous CLI live session cleanup has not settled.");
      }
      current = handle;
      handles.add(handle);
    },
    activate: () => {},
    remove: (handle) => {
      if (current === handle) {
        current = undefined;
        if (cleanup) {
          retiredCleanup = handle
            .waitForExit()
            .then(cleanup)
            .then(() => {
              retiredCleanup = undefined;
            });
        }
      }
    },
  };
}

async function collect(context: CliBackendExecuteContext) {
  const records: Record<string, unknown>[] = [];
  for await (const record of executeClaudeCli(context)) {
    records.push(record);
  }
  return records;
}

function resultDetail(records: Record<string, unknown>[]): Record<string, unknown> {
  const result = records.findLast((record) => record.type === "result");
  expect(result).toEqual(
    expect.objectContaining({ subtype: "success", result: expect.any(String) }),
  );
  return JSON.parse(String(result?.result)) as Record<string, unknown>;
}

describe("Claude native stdio boundary", () => {
  it.each([
    { scenario: "shutdown-ignore", name: "native parent and child ignore EOF and SIGTERM" },
    { scenario: "shutdown-eof", name: "native parent exits immediately on EOF" },
  ])(
    "closes its whole process tree within the host cancellation window when $name",
    async ({ scenario }) => {
      const liveSession = createLiveSession();
      const context = await createContext(scenario, { liveSession });
      const iterator = executeClaudeCli(context)[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.value).toMatchObject({
        subtype: "fixture_shutdown",
        pid: expect.any(Number),
        descendantPid: expect.any(Number),
      });
      const pids = [Number(first.value?.pid), Number(first.value?.descendantPid)];
      const deadline = AbortSignal.timeout(4_000);
      const deadlineExceeded = new Promise<never>((_resolve, reject) => {
        deadline.addEventListener(
          "abort",
          () => reject(new Error("Native shutdown exceeded the host cancellation window.")),
          { once: true },
        );
      });
      try {
        await Promise.race([
          (async () => {
            await iterator.return?.();
            await vi.waitFor(() => {
              for (const pid of pids) {
                expect(() => process.kill(pid, 0)).toThrow();
              }
            });
          })(),
          deadlineExceeded,
        ]);
        expect(liveSession.current()).toBeUndefined();
      } finally {
        for (const pid of pids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
    },
  );

  it("starts a fresh process after host cleanup when the execution fingerprint changes", async () => {
    const gate = createDeferred<void>();
    const cleanup = vi.fn(() => gate.promise);
    const liveSession = createLiveSession(cleanup);
    const context = await createContext("normal", { liveSession });
    const first = resultDetail(await collect(context));
    liveSession.fingerprint = "changed-authoritative-prompt";
    const pending = collect({
      ...context,
      useResume: true,
      systemPrompt: "changed authoritative instructions",
    });
    void pending.catch(() => {});
    try {
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
      expect(liveSession.current()).toBeUndefined();
      gate.resolve();
      const second = resultDetail(await pending);
      expect(second.pid).not.toBe(first.pid);
      expect(second.turn).toBe(1);
      expect(second.initialize).toMatchObject({
        appendSystemPrompt: "changed authoritative instructions",
      });
      expect(() => process.kill(Number(first.pid), 0)).toThrow();
    } finally {
      gate.resolve();
    }
  });

  it("refuses process startup when the admitted owner rejects capture activation", async () => {
    const liveSession = createLiveSession();
    const reason = new Error("Synthetic capture owner rejected this run.");
    liveSession.activate = () => {
      throw reason;
    };
    const context = await createContext("normal", { liveSession });
    await expect(collect(context)).rejects.toBe(reason);
    expect(liveSession.current()).toBeUndefined();
    await expect(access(path.join(context.cwd, "fixture.pid"))).rejects.toThrow();
  });

  it("keeps an interim result open until native background agents report their final answer", async () => {
    const context = await createContext("background-success", { liveSession: createLiveSession() });
    let settled = false;
    const running = collect(context).then((records) => {
      settled = true;
      return records;
    });
    await vi.waitFor(async () => {
      expect(await readFile(path.join(context.cwd, "background.ready"), "utf8")).toBe("ready");
    });
    expect(settled).toBe(false);
    await writeFile(path.join(context.cwd, "background.release"), "release");
    expect(resultDetail(await running).finalBackgroundAnswer).toBe(true);
  });

  it.each([
    { type: "token" as const, descriptor: "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR" },
    { type: "api_key" as const, descriptor: "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR" },
  ])(
    "keeps a selected $type in a reopenable one-use descriptor and closes its process tree",
    async ({ type, descriptor }) => {
      const context = await createContext("credential-tree", { liveSession: createLiveSession() });
      const credential = "synthetic-selected-descriptor-value";
      const backend = buildAnthropicCliBackend();
      const prepared = (await backend.prepareExecution?.({
        workspaceDir: context.cwd,
        provider: "claude-cli",
        modelId: context.modelId,
        executionMode: "agent",
        authCredential: type === "token" ? { type, token: credential } : { type, key: credential },
      } as Parameters<NonNullable<typeof backend.prepareExecution>>[0])) as
        | (CliBackendPreparedExecution & { secretInput?: ClaudeCliSecretInput })
        | undefined;
      if (!prepared?.execute || !prepared.secretInput || !prepared.cleanup) {
        throw new Error("Expected provider-owned credential execution.");
      }
      const buffers: Buffer[] = [];
      const createData = prepared.secretInput.createData;
      vi.spyOn(prepared.secretInput, "createData").mockImplementation(() => {
        const bytes = createData();
        buffers.push(bytes);
        return bytes;
      });
      Object.assign(context.env, prepared.env);
      const iterator = prepared.execute(context)[Symbol.asyncIterator]();
      let descendantPid: number | undefined;
      try {
        const first = await iterator.next();
        descendantPid = Number(first.value?.descendantPid);
        expect(context.env[descriptor]).toBe("3");
        expect(first.value).toMatchObject({
          subtype: "fixture_credential",
          descriptor: "3",
          digest: createHash("sha256").update(credential).digest("hex"),
          credentialInArgs: false,
          credentialInEnv: false,
        });
      } finally {
        await iterator.return?.();
        await prepared.cleanup();
      }
      try {
        await vi.waitFor(() => expect(() => process.kill(descendantPid!, 0)).toThrow());
      } finally {
        if (descendantPid) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {}
        }
      }
      expect(buffers.length).toBeGreaterThan(0);
      expect(buffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
      expect(() => prepared.secretInput?.createData()).toThrow("no longer available");
    },
  );

  it("denies an awaited hook decision when its admitted authority is revoked", async () => {
    let active = true;
    const approvalStarted = createDeferred<void>();
    const approval = createDeferred<CliBackendToolPermissionResult>();
    const context = await createContext("revoked-approval", {
      liveSession: createLiveSession(),
      assertCurrent: () => {
        if (!active) {
          throw new Error("Synthetic owner revoked.");
        }
      },
      requestToolPermission: () => {
        approvalStarted.resolve();
        return approval.promise;
      },
    });
    const running = collect(context);
    await approvalStarted.promise;
    active = false;
    approval.resolve({ behavior: "allow", updatedInput: { file_path: "approved.txt" } });
    const detail = resultDetail(await running);
    expect(detail.hookDecision).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(detail.hookDecision).not.toHaveProperty("hookSpecificOutput.updatedInput");
  });

  it("preserves native resume and plugin controls while sending the private system prompt only over stdin", async () => {
    const context = await createContext("normal", {
      liveSession: createLiveSession(),
      sessionId: "a174e16f-b6e9-48da-ad5a-c437dfc2f9b4",
      useResume: true,
    });
    const nativeArgs = [
      "--fork-session",
      "--resume-session-at",
      "checkpoint-before-stall",
      "--plugin-dir",
      "/tmp/synthetic-skills",
      "--plugin-dir-no-mcp",
      "/tmp/synthetic-isolated-skills",
      "--effort",
      "max",
      "--mcp-config",
      "/tmp/synthetic-private-mcp.json",
      "--strict-mcp-config",
      "--add-dir",
      "/tmp/synthetic-a",
      "/tmp/synthetic-b",
      "--cache-system-prompt",
    ];
    context.args = [...context.args, ...nativeArgs, "--exclude-dynamic-system-prompt-sections"];
    const detail = resultDetail(await collect(context));
    const args = detail.argv as string[];

    expect(args.slice(0, nativeArgs.length)).toEqual(nativeArgs);
    expect(args).toEqual(expect.arrayContaining(["--resume", context.sessionId]));
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain(context.systemPrompt);
    expect(detail.initialize).toMatchObject({
      appendSystemPrompt: context.systemPrompt,
      excludeDynamicSections: true,
    });
  });

  it("leaves admitted OpenClaw MCP tools with their own host policy", async () => {
    const context = await createContext("mcp-hook", { liveSession: createLiveSession() });
    const detail = resultDetail(await collect(context));
    expect(detail.hookDecision).toEqual({ continue: true });
    expect(context.requestToolPermission).not.toHaveBeenCalled();
  });

  it("declines unsupported MCP elicitation without interrupting the native turn", async () => {
    const context = await createContext("mcp-elicitation", { liveSession: createLiveSession() });
    const detail = resultDetail(await collect(context));
    expect(detail.elicitation).toEqual({ action: "decline" });
    expect(context.requestUserInput).not.toHaveBeenCalled();
    expect(context.requestToolPermission).not.toHaveBeenCalled();
  });

  it("ignores replayed records until the lifecycle acknowledges the current input UUID", async () => {
    const context = await createContext("input-lifecycle", {
      liveSession: createLiveSession(),
      requestToolPermission: vi.fn<CliBackendExecuteContext["requestToolPermission"]>(
        async ({ toolInput }) => ({
          behavior: "allow",
          updatedInput: toolInput,
        }),
      ),
    });
    for (const prompt of ["first input", "second input"]) {
      const records = await collect({
        ...context,
        prompt,
        promptContext: { prependContext: "current private context" },
      });
      expect(records.filter((record) => record.type === "result")).toHaveLength(1);
      expect(records.some((record) => record.type === "assistant")).toBe(false);
      const detail = resultDetail(records);
      expect(detail).toMatchObject({ user: prompt, matchedInputUuid: expect.any(String) });
      if (prompt === "second input") {
        expect(detail.priorResponses).toMatchObject({
          "prior-pre": { hookSpecificOutput: { permissionDecision: "deny" } },
          "prior-permission": { behavior: "deny" },
          "prior-context": {},
        });
        expect((detail.priorResponses as Record<string, unknown>)["prior-context"]).toEqual({});
      }
    }
    expect(context.requestToolPermission).not.toHaveBeenCalled();
  });

  it("closes a partially consumed native process when its event iterator is returned", async () => {
    const liveSession = createLiveSession();
    const context = await createContext("stream-then-wait", { liveSession });
    const iterator = executeClaudeCli(context)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({ subtype: "fixture_waiting", pid: expect.any(Number) });
    const pid = Number(first.value?.pid);
    await iterator.return?.();
    expect(liveSession.current()).toBeUndefined();
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("rejects an already aborted run before reading its credential or creating a native process", async () => {
    const controller = new AbortController();
    const reason = new Error("Synthetic owner cancelled before startup.");
    controller.abort(reason);
    const context = await createContext("normal", { abortSignal: controller.signal });
    const createData = vi.fn(() => Buffer.from("synthetic unused credential"));
    const run = async () => {
      for await (const record of executeClaudeCli(context, { fd: 3, createData })) {
        void record;
      }
    };
    await expect(run()).rejects.toBe(reason);
    expect(createData).not.toHaveBeenCalled();
    await expect(access(path.join(context.cwd, "fixture.pid"))).rejects.toThrow();
  });

  it("revalidates the admitted owner after native initialization before sending any user input", async () => {
    let active = true;
    const reason = new Error("Synthetic admitted owner was released.");
    const liveSession = createLiveSession();
    const context = await createContext("revoked-initialize", {
      liveSession,
      assertCurrent: () => {
        if (!active) {
          throw reason;
        }
      },
    });
    const running = collect(context);
    const outcome = running.catch((error: unknown) => error);
    await vi.waitFor(async () => {
      expect(await readFile(path.join(context.cwd, "initialize.ready"), "utf8")).toBe("ready");
    });
    active = false;
    await writeFile(path.join(context.cwd, "initialize.release"), "release");
    expect(await outcome).toBe(reason);
    expect(liveSession.current()).toBeUndefined();
    await expect(access(path.join(context.cwd, "user.received"))).rejects.toThrow();
  });

  it("reuses one child while delivering private context and host permissions for each turn", async () => {
    const liveSession = createLiveSession();
    const context = await createContext("normal", {
      liveSession,
      prompt: "Remember orange.",
      promptContext: { prependContext: "private prefix", appendContext: "private suffix" },
    });
    const first = resultDetail(await collect(context));
    const handle = liveSession.current();
    const second = resultDetail(
      await collect({
        ...context,
        prompt: "Which color?",
        promptContext: { prependContext: "second private context" },
        useResume: true,
      }),
    );

    expect(first).toMatchObject({
      turn: 1,
      user: "Remember orange.",
      privateContext: "private prefix\n\nprivate suffix",
      permission: { behavior: "deny" },
    });
    expect(second).toMatchObject({
      turn: 2,
      user: "Which color?",
      privateContext: "second private context",
      pid: first.pid,
    });
    expect(liveSession.current()).toBe(handle);
    expect(handle?.isIdle()).toBe(true);
    expect(context.requestToolPermission).toHaveBeenCalledTimes(4);
    expect(context.requestToolPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: context.cwd,
        toolName: "Read",
        toolInput: { file_path: "fixture.txt" },
      }),
    );
  });

  it("answers a native user question once when both hook and permission callbacks request it", async () => {
    const requestUserInput = vi.fn(async () => ({
      status: "answered" as const,
      answers: { question_1: ["Shared flow"] },
    }));
    const context = await createContext("user-question", {
      liveSession: createLiveSession(),
      requestUserInput,
    });
    const detail = resultDetail(await collect(context));

    expect(detail.permission).toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "Which path should Claude take?": "Shared flow" } },
    });
    expect(requestUserInput).toHaveBeenCalledOnce();
    expect(context.requestToolPermission).not.toHaveBeenCalled();
  });

  it("keeps bypass arguments and native allow rules behind the admitted host policy", async () => {
    const context = await createContext("normal", {
      liveSession: createLiveSession(),
      toolAvailability: { native: ["Read"], openClaw: ["message"] },
    });
    context.args = [
      ...context.args,
      "--permission-mode",
      "bypassPermissions",
      "--allowedTools",
      "Bash",
      "mcp__openclaw__*",
    ];
    const detail = resultDetail(await collect(context));
    const args = detail.argv as string[];
    const flagValues = (flag: string) => {
      const start = args.indexOf(flag);
      if (start === -1) {
        return [];
      }
      const end = args.findIndex((argument, index) => index > start && argument.startsWith("--"));
      return args
        .slice(start + 1, end === -1 ? undefined : end)
        .flatMap((value) => value.split(","));
    };

    expect(args).not.toContain("bypassPermissions");
    expect(flagValues("--permission-mode")).toEqual(["default"]);
    expect(flagValues("--tools")).toEqual(["Read"]);
    expect(flagValues("--allowedTools")).toEqual(["mcp__openclaw__message"]);
    expect(context.requestToolPermission).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending native permission without blocking the protocol reader", async () => {
    let cancelled = false;
    const context = await createContext("cancel-permission", {
      liveSession: createLiveSession(),
      requestToolPermission: vi.fn<CliBackendExecuteContext["requestToolPermission"]>(
        async ({ toolInput, abortSignal }) => {
          if (toolInput.file_path === "cancel.txt") {
            await new Promise<void>((resolve) => {
              if (abortSignal?.aborted) {
                resolve();
              } else {
                abortSignal?.addEventListener("abort", () => resolve(), { once: true });
              }
            });
            cancelled = true;
          }
          return { behavior: "deny", message: "Fixture denied." };
        },
      ),
    });

    const detail = resultDetail(await collect(context));

    expect(cancelled).toBe(true);
    expect(detail.cancelledDecision).toMatchObject({ behavior: "deny" });
    expect(context.requestToolPermission).toHaveBeenCalledTimes(3);
  });

  it("fences a permission decision from the completed turn after the next turn starts", async () => {
    const approval = createDeferred<CliBackendToolPermissionResult>();
    const context = await createContext("late-approval", {
      liveSession: createLiveSession(),
      requestToolPermission: vi.fn<CliBackendExecuteContext["requestToolPermission"]>(
        () => approval.promise,
      ),
    });
    await collect(context);
    expect(context.requestToolPermission).toHaveBeenCalledOnce();
    const records: Record<string, unknown>[] = [];
    for await (const record of executeClaudeCli({
      ...context,
      prompt: "next admitted turn",
      useResume: true,
    })) {
      records.push(record);
      if (record.subtype === "fixture_second_turn") {
        approval.resolve({ behavior: "allow", updatedInput: { command: "echo late" } });
      }
    }

    expect(resultDetail(records).lateDecision).toMatchObject({
      behavior: "deny",
      message: "The OpenClaw run is no longer active.",
    });
    expect(context.requestToolPermission).toHaveBeenCalledOnce();
  });

  it("frames a large native record across UTF-8 byte boundaries without corrupting it", async () => {
    const records = await collect(
      await createContext("large-split-record", {
        liveSession: createLiveSession(),
      }),
    );
    expect(records).toContainEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "🦞" + "x".repeat(300_000) + "🦞" }],
      },
    });
    expect(resultDetail(records).turn).toBe(1);
  });

  it("reports a native exit with bounded process diagnostics instead of a successful empty reply", async () => {
    const error = await collect(
      await createContext("missing-result", {
        liveSession: createLiveSession(),
      }),
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(formatErrorMessageForDisplay(error)).toContain(
      "PermissionError: fixture cannot read its input",
    );
  });

  it("keeps an ordinary failed turn warm when no native background work remains", async () => {
    const liveSession = createLiveSession();
    const context = await createContext("ordinary-error", { liveSession });
    const first = await collect(context);
    expect(first.at(-1)).toMatchObject({
      type: "result",
      is_error: true,
      errors: ["fixture foreground turn failed"],
    });
    const handle = liveSession.current();
    expect(handle?.isIdle()).toBe(true);
    const second = resultDetail(await collect({ ...context, useResume: true }));
    expect(second.turn).toBe(2);
    expect(liveSession.current()).toBe(handle);
  });

  it.each([
    {
      scenario: "background-error",
      expected: { is_error: true, errors: ["fixture background turn failed"] },
    },
    {
      scenario: "background-raw-result",
      expected: { result: expect.stringContaining('<invoke name="Read">') },
    },
  ])(
    "ends $scenario immediately while native background work remains listed",
    async ({ scenario, expected }) => {
      const liveSession = createLiveSession();
      const context = await createContext(scenario, { liveSession });
      const records = await collect(context);
      expect(records.at(-1)).toMatchObject({ type: "result", ...expected });
      const firstPid = Number(await readFile(path.join(context.cwd, "fixture.pid"), "utf8"));
      expect(liveSession.current()).toBeUndefined();
      expect(() => process.kill(firstPid, 0)).toThrow();
      const second = await collect({ ...context, useResume: true });
      expect(second.at(-1)).toMatchObject({ type: "result", ...expected });
      const secondPid = Number(await readFile(path.join(context.cwd, "fixture.pid"), "utf8"));
      expect(secondPid).not.toBe(firstPid);
      expect(liveSession.current()).toBeUndefined();
    },
  );
});
