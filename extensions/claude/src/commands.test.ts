import { beforeEach, describe, expect, it } from "vitest";
import { THREAD_STACK_MAX, type ClaudeAppServerBindingStore } from "./app-server/thread-store.js";
import { createClaudeTestBindingStore } from "./app-server/thread-store.test-helpers.js";
import { createClaudeCommand, handleClaudeCommand } from "./commands.js";

const SESSION_KEY = "agent:main:direct:tester";
const SESSION_ID = "sess-1";
const IDENTITY = { sessionKey: SESSION_KEY, sessionId: SESSION_ID };

function makeCtx(overrides: Partial<Parameters<typeof handleClaudeCommand>[0]> = {}) {
  return {
    channel: "discord",
    isAuthorizedSender: true,
    commandBody: "/claude",
    config: {},
    ...overrides,
  } as unknown as Parameters<typeof handleClaudeCommand>[0];
}

function sessionCtx(args: string) {
  return makeCtx({ args, sessionKey: SESSION_KEY, sessionId: SESSION_ID });
}

describe("createClaudeCommand", () => {
  it("registers a reserved /claude command that accepts args", () => {
    const def = createClaudeCommand();
    expect(def.name).toBe("claude");
    expect(def.acceptsArgs).toBe(true);
    expect(def.requireAuth).toBe(true);
    expect(def.ownership).toBe("reserved");
  });
});

describe("/claude subcommand routing", () => {
  it("defaults to help when no args are supplied", async () => {
    const result = await handleClaudeCommand(makeCtx({ args: "" }));
    expect(result.text).toContain("Inspect and control");
    expect(result.text).toContain("`status`");
  });

  it("routes 'help' explicitly", async () => {
    const result = await handleClaudeCommand(makeCtx({ args: "help" }));
    expect(result.text).toContain("Subcommands:");
  });

  it("returns status without spawning the shared client when no turn has run", async () => {
    const result = await handleClaudeCommand(makeCtx({ args: "status" }));
    expect(result.text).toContain("Claude app-server status");
    expect(result.text).toContain("not yet created");
  });

  it("reports plugin, minimum-required, bundled, and running bridge versions", async () => {
    const result = await handleClaudeCommand(makeCtx({ args: "version" }));
    expect(result.text).toContain("Claude harness versions");
    expect(result.text).toContain("Minimum bridge required:");
    // Running line is present even when no turn has run ("not running"); the
    // bundled line tolerates an absent managed binary so the test stays
    // hermetic without a real install.
    expect(result.text).toContain("Running bridge (spawned):");
    expect(result.text).toContain("Bundled bridge (managed):");
  });

  it("threads: reports missing-session when no session is bound", async () => {
    const result = await handleClaudeCommand(makeCtx({ args: "threads" }), {
      bindingStore: createClaudeTestBindingStore(),
    });
    expect(result.text).toContain("No session is bound");
  });

  it("resume: requires a thread_id argument", async () => {
    const result = await handleClaudeCommand(sessionCtx("resume"), {
      bindingStore: createClaudeTestBindingStore(),
    });
    expect(result.text).toContain("Usage: `/claude resume <thread_id>`");
  });
});

describe("/claude threads + resume against a real binding store", () => {
  let store: ClaudeAppServerBindingStore;
  const run = (args: string) => handleClaudeCommand(sessionCtx(args), { bindingStore: store });

  beforeEach(() => {
    store = createClaudeTestBindingStore();
  });

  it("threads: prints a 'no binding' note when none exists", async () => {
    const result = await run("threads");
    expect(result.text).toContain("No claude thread is bound to this session yet");
  });

  it("threads: prints the binding contents when present", async () => {
    await store.write(IDENTITY, {
      threadId: "thr_test_abc",
      cwd: "/tmp/ws",
      model: "claude-sonnet-4-6",
      modelProvider: "anthropic",
    });
    const result = await run("threads");
    expect(result.text).toContain("`thr_test_abc`");
    expect(result.text).toContain("claude-sonnet-4-6");
  });

  it("threads: renders 'Updated' as a current-era date, not 1970 (C1 seconds-vs-ms)", async () => {
    await store.write(IDENTITY, {
      threadId: "thr_ts",
      cwd: "/tmp/ws",
      model: "claude-sonnet-4-6",
    });
    const result = await run("threads");
    const match = (result.text ?? "").match(/Updated: (\S+)/);
    expect(match).not.toBeNull();
    const year = new Date(match?.[1] ?? "").getUTCFullYear();
    // Seconds-as-ms rendered 1970; ms renders the real year.
    expect(year).toBeGreaterThanOrEqual(2026);
  });

  it("threads: shows turn-completion summary fields when present", async () => {
    await store.write(IDENTITY, {
      threadId: "thr_summary",
      cwd: "/tmp/ws",
      model: "claude-sonnet-5",
    });
    await store.recordTurnSummary(IDENTITY, {
      stopReason: "toolUse",
      usage: { input: 500, output: 42, total: 542 },
      assistantPreview: "I ran the tests and they pass.",
    });
    const result = await run("threads");
    expect(result.text).toContain("Turns completed: 1");
    expect(result.text).toContain("Last stop reason: toolUse");
    expect(result.text).toContain("500 in / 42 out / 542 total tokens");
    expect(result.text).toContain("I ran the tests and they pass.");
  });

  it("resume: writes a fresh binding when none exists", async () => {
    const result = await run("resume thr_new_xyz");
    expect(result.text).toContain("Rebound session to thread `thr_new_xyz`");
    const after = await run("threads");
    expect(after.text).toContain("`thr_new_xyz`");
  });

  it("resume: preserves existing binding fields when rotating thread id", async () => {
    await store.write(IDENTITY, {
      threadId: "thr_old",
      cwd: "/tmp/ws",
      model: "claude-sonnet-4-6",
      approvalPolicy: "on-request",
    });
    await run("resume thr_new");
    const after = await run("threads");
    expect(after.text).toContain("`thr_new`");
    expect(after.text).toContain("claude-sonnet-4-6");
    expect(after.text).toContain("on-request");
  });

  it("resume: pushes the thread being switched away from onto the back-stack", async () => {
    await store.write(IDENTITY, { threadId: "thr_a", cwd: "/tmp/ws" });
    const result = await run("resume thr_b");
    expect(result.text).toContain("`thr_a` pushed onto the back-stack");
    const after = await run("threads");
    expect(after.text).toContain("Back-stack: 1 thread(s)");
  });

  it("resume: does not push when resuming to the thread already bound (no-op switch)", async () => {
    await store.write(IDENTITY, { threadId: "thr_a", cwd: "/tmp/ws" });
    const result = await run("resume thr_a");
    expect(result.text).not.toContain("pushed onto the back-stack");
    const after = await run("threads");
    expect(after.text).not.toContain("Back-stack");
  });

  it("thread-pop: reports nothing to pop when the stack is empty", async () => {
    await store.write(IDENTITY, { threadId: "thr_a", cwd: "/tmp/ws" });
    const result = await run("thread-pop");
    expect(result.text).toContain("No previous thread on the back-stack");
  });

  it("thread-pop: reports missing session when no session is bound", async () => {
    const result = await handleClaudeCommand(makeCtx({ args: "thread-pop" }), {
      bindingStore: store,
    });
    expect(result.text).toContain("No session is bound");
  });

  it("thread-pop: rotates back to the previous thread, LIFO across multiple switches", async () => {
    await store.write(IDENTITY, { threadId: "thr_a", cwd: "/tmp/ws" });
    await run("resume thr_b"); // stack: [a]
    await run("resume thr_c"); // stack: [a, b]

    const pop1 = await run("thread-pop");
    expect(pop1.text).toContain("Popped back to thread `thr_b`");
    expect(pop1.text).toContain("(1 more on the back-stack.)");

    const pop2 = await run("thread-pop");
    expect(pop2.text).toContain("Popped back to thread `thr_a`");
    expect(pop2.text).toContain("(0 more on the back-stack.)");

    const pop3 = await run("thread-pop");
    expect(pop3.text).toContain("No previous thread on the back-stack");
  });

  it("resume: caps the back-stack at THREAD_STACK_MAX, dropping the oldest entries", async () => {
    await store.write(IDENTITY, { threadId: "thr_0", cwd: "/tmp/ws" });
    for (let i = 1; i <= THREAD_STACK_MAX + 2; i += 1) {
      await run(`resume thr_${i}`);
    }
    const after = await run("threads");
    expect(after.text).toContain(`Back-stack: ${THREAD_STACK_MAX} thread(s)`);
    // Popping now should bring back the most recent pre-cap switch (thr_{THREAD_STACK_MAX+1}),
    // not thr_0, which was dropped for being the oldest.
    const pop = await run("thread-pop");
    expect(pop.text).toContain(`Popped back to thread \`thr_${THREAD_STACK_MAX + 1}\``);
  });

  it("thread-pop: preserves other binding fields when rotating back", async () => {
    await store.write(IDENTITY, {
      threadId: "thr_a",
      cwd: "/tmp/ws",
      model: "claude-sonnet-4-6",
    });
    await run("resume thr_b");
    await run("thread-pop");
    const after = await run("threads");
    expect(after.text).toContain("`thr_a`");
    expect(after.text).toContain("claude-sonnet-4-6");
  });
});
