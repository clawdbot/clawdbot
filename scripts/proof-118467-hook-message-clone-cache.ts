/**
 * Real-behavior proof for the `llm_input` settled-history clone cache
 * (PR #118467), and specifically for the typed-array deep-freeze crash.
 *
 * What is REAL here (no vitest, no mocks of the seam under test):
 *   - `cloneLlmInputHookMessages()` — the changed owner.
 *   - `initializeGlobalHookRunner()` + `getGlobalHookRunner()` — the real
 *     process-wide hook-runner singletons, initialized from a real
 *     `GlobalHookRunnerRegistry` (a plain production data shape) carrying a real
 *     typed `llm_input` registration. Dispatch, timeouts and error policy are
 *     the production runner's, not a stand-in.
 *   - The production CALL EXPRESSION from
 *     `src/agents/embedded-agent-runner/run/attempt-prompt-support.ts`:
 *       void runner.runLlmInput({ …, historyMessages: clone(msgs) }, ctx).catch(…)
 *     reproduced verbatim, because the bug's severity comes entirely from
 *     *where* the clone sits — in the argument list, evaluated before any
 *     promise exists, so the trailing `.catch()` cannot contain a throw.
 *   - Real `structuredClone` / `Object.freeze` semantics on real typed arrays.
 *
 * What is NOT executed: the embedded agent runner's surrounding prompt phase
 * (it needs a live Gateway, provider session and transcript store). Scenario 2
 * substitutes for it by proving the containment property of the call expression
 * directly — that a throw raised during argument evaluation bypasses `.catch()`
 * and escapes synchronously to the caller, which in production is
 * `attempt-prompt-phase.ts` with no try/catch around it.
 *
 * Scenarios:
 *   1. PRE-FIX CONTROL — the pre-fix `deepFreeze` (inlined verbatim below) over
 *      a settled custom message whose `details` hold a non-empty `Uint8Array`.
 *      Throws `TypeError: Cannot freeze array buffer views with elements`.
 *   2. Containment — that throw escapes the production call expression
 *      synchronously and the `.catch()` handler never runs. This is why the
 *      defect aborts the prompt phase instead of degrading to a logged warning.
 *   3. POST-FIX — the shipped `cloneLlmInputHookMessages` over the same history:
 *      no throw, the hook actually observes the bytes, the surrounding object
 *      graph is frozen, and the view itself is deliberately not.
 *   4. Freeze-safe views (empty typed array, `DataView`) are unchanged.
 *   5. Isolation and caching still hold: the clone is detached from the source
 *      and one clone is reused per settled message.
 *   6. Large binary payloads no longer walk one own-key per byte — the pre-fix
 *      `Reflect.ownKeys` cost is measured against the post-fix constant cost.
 *
 * Run: pnpm tsx scripts/proof-118467-hook-message-clone-cache.ts
 */
import assert from "node:assert/strict";
import type { AgentMessage } from "../src/agents/runtime/index.js";
import type { GlobalHookRunnerRegistry } from "../src/plugins/hook-registry.types.js";

let failures = 0;

function check(label: string, run: () => void): void {
  try {
    run();
    console.log(`   ✓ ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`   ✗ ${label}`);
    console.log(`     ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The pre-fix `deepFreeze`, copied verbatim from this branch's parent commit so
 * the control scenario reproduces the shipped defect rather than describing it.
 */
function deepFreezePreFix<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreezePreFix(Reflect.get(value, key), seen);
  }
  return Object.freeze(value);
}

function clonePreFix(messages: AgentMessage[]): AgentMessage[] {
  const freshFrom = Math.max(0, messages.length - 2);
  return messages.map((message, index) => {
    if (index >= freshFrom || !message || typeof message !== "object") {
      return structuredClone(message);
    }
    return deepFreezePreFix(structuredClone(message));
  });
}

function assistantMsg(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 1 } as never;
}

/** A valid `CustomMessage` whose `details` (typed `T = unknown`) hold binary metadata. */
function binaryCustomMsg(bytes: Uint8Array): AgentMessage {
  return {
    role: "custom",
    customType: "app.audio-clip",
    content: [{ type: "text", text: "audio clip attached" }],
    display: false,
    details: { codec: "opus", payload: bytes },
    timestamp: 1,
  } as never;
}

async function main(): Promise<void> {
  const { cloneLlmInputHookMessages } =
    await import("../src/agents/embedded-agent-runner/run/attempt-hook-messages.js");
  const { initializeGlobalHookRunner, getGlobalHookRunner } =
    await import("../src/plugins/hook-runner-global.js");

  // A real registry shape with a real typed llm_input registration.
  const observed: Array<{ historyMessages: unknown[] }> = [];
  const registry: GlobalHookRunnerRegistry = {
    hooks: [],
    typedHooks: [
      {
        pluginId: "proof-118467",
        hookName: "llm_input",
        handler: (event) => {
          observed.push({ historyMessages: event.historyMessages });
        },
      },
    ],
    plugins: [{ id: "proof-118467", status: "loaded" }],
  } as never;
  initializeGlobalHookRunner(registry);
  const runner = getGlobalHookRunner();
  assert.ok(runner, "the real global hook runner failed to initialize");
  assert.ok(runner.hasHooks("llm_input"), "the real runner did not see the llm_input hook");
  console.log("   real global hook runner initialized; hasHooks('llm_input') = true");

  const ctx = {
    runId: "proof-run",
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "proof-session",
    workspaceDir: process.cwd(),
    trigger: "message",
  } as never;

  /**
   * The production call expression, verbatim in shape: the clone is an argument,
   * so it is evaluated before `runLlmInput` can return a promise to `.catch()`.
   */
  const dispatchLikeProduction = (
    clone: (messages: AgentMessage[]) => AgentMessage[],
    messages: AgentMessage[],
  ): { threwSynchronously: Error | null; catchHandlerRan: boolean } => {
    const state = { threwSynchronously: null as Error | null, catchHandlerRan: false };
    try {
      void runner
        .runLlmInput(
          {
            runId: "proof-run",
            sessionId: "proof-session",
            provider: "anthropic",
            model: "claude-opus-5",
            prompt: "proof prompt",
            historyMessages: clone(messages),
            imagesCount: 0,
          },
          ctx,
        )
        .catch(() => {
          state.catchHandlerRan = true;
        });
    } catch (error) {
      state.threwSynchronously = error as Error;
    }
    return state;
  };

  // Index 0 of 3 is settled history, so it takes the deep-freeze/cache path
  // rather than the always-fresh trailing pair.
  const binaryHistory = () => [
    binaryCustomMsg(new Uint8Array([1, 2, 3])),
    assistantMsg("tail1"),
    assistantMsg("tail2"),
  ];

  console.log("\n── scenario 1+2: PRE-FIX CONTROL and containment ──");
  {
    const result = dispatchLikeProduction(clonePreFix, binaryHistory());
    console.log(`   synchronous throw: ${result.threwSynchronously?.message ?? "(none)"}`);
    console.log(`   .catch() handler ran: ${result.catchHandlerRan}`);
    check("pre-fix clone throws the reported TypeError", () => {
      assert.ok(result.threwSynchronously, "pre-fix clone did not throw");
      assert.match(
        result.threwSynchronously.message,
        /Cannot freeze array buffer views with elements/,
      );
      assert.equal(result.threwSynchronously.constructor.name, "TypeError");
    });
    check("the trailing .catch() cannot contain it — the throw escapes synchronously", () => {
      // This is the severity claim: the failure is not a logged hook warning,
      // it unwinds into the caller, which has no try/catch around this call.
      assert.equal(result.catchHandlerRan, false, ".catch() unexpectedly handled the failure");
      assert.ok(result.threwSynchronously instanceof Error);
    });
    check("no hook observation happened, so the prompt never reached the model", () => {
      assert.equal(observed.length, 0);
    });
  }

  console.log("\n── scenario 3: POST-FIX — the shipped clone over the same history ──");
  {
    observed.length = 0;
    const source = binaryHistory();
    const result = dispatchLikeProduction(cloneLlmInputHookMessages, source);
    // Let the real runner's async dispatch settle.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    check("no synchronous throw escapes the production call expression", () => {
      assert.equal(result.threwSynchronously, null);
      assert.equal(result.catchHandlerRan, false);
    });
    check("the real hook observed the history, including the binary payload", () => {
      assert.equal(observed.length, 1, "the real hook runner never dispatched");
      const first = observed[0]!.historyMessages[0] as {
        details: { codec: string; payload: Uint8Array };
      };
      assert.equal(first.details.codec, "opus");
      assert.ok(first.details.payload instanceof Uint8Array);
      assert.deepEqual(Array.from(first.details.payload), [1, 2, 3]);
    });
    check("the surrounding object graph is frozen; only the view is exempt", () => {
      const first = observed[0]!.historyMessages[0] as {
        details: { payload: Uint8Array };
      };
      assert.equal(Object.isFrozen(first), true, "the message itself was not frozen");
      assert.equal(Object.isFrozen(first.details), true, "details was not frozen");
      // Stated honestly: freezing a view was never protective (it cannot make
      // backing bytes read-only) and is exactly what threw.
      assert.equal(Object.isFrozen(first.details.payload), false);
    });
    check("the observed clone is detached from the live session message", () => {
      const first = observed[0]!.historyMessages[0] as {
        details: { payload: Uint8Array };
      };
      const sourceDetails = (source[0] as unknown as { details: { payload: Uint8Array } }).details;
      assert.notEqual(first.details.payload, sourceDetails.payload);
      assert.notEqual(first, source[0]);
    });
  }

  console.log("\n── scenario 4: freeze-safe views are unchanged ──");
  {
    const safe = {
      role: "custom",
      customType: "app.empty",
      content: [{ type: "text", text: "empty" }],
      display: false,
      details: { payload: new Uint8Array([]), view: new DataView(new ArrayBuffer(4)) },
      timestamp: 1,
    } as never as AgentMessage;
    const cloned = cloneLlmInputHookMessages([safe, assistantMsg("t1"), assistantMsg("t2")]);
    const details = (cloned[0] as unknown as { details: { payload: Uint8Array; view: DataView } })
      .details;
    check("an empty typed array and a DataView clone and freeze without throwing", () => {
      assert.equal(details.payload.length, 0);
      assert.equal(details.view.byteLength, 4);
      assert.equal(Object.isFrozen(cloned[0]), true);
      assert.equal(Object.isFrozen(details), true);
    });
  }

  console.log("\n── scenario 5: the settled-history cache still holds ──");
  {
    const source = [
      binaryCustomMsg(new Uint8Array([7, 7])),
      assistantMsg("h2"),
      assistantMsg("tail1"),
      assistantMsg("tail2"),
    ];
    const first = cloneLlmInputHookMessages(source);
    const second = cloneLlmInputHookMessages(source);
    check("settled entries are served from the cache, the tail is re-cloned", () => {
      assert.equal(second[0], first[0], "settled binary message was not cached");
      assert.equal(second[1], first[1]);
      assert.notEqual(second[2], first[2]);
      assert.notEqual(second[3], first[3]);
    });
  }

  console.log("\n── scenario 6: large binary payloads no longer walk one key per byte ──");
  {
    const bytes = new Uint8Array(256 * 1024);
    bytes[0] = 42;
    const ownKeyCount = Reflect.ownKeys(bytes).length;
    const source = [binaryCustomMsg(bytes), assistantMsg("t1"), assistantMsg("t2")];
    const startedAt = process.hrtime.bigint();
    const cloned = cloneLlmInputHookMessages(source);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(
      `   a ${bytes.length}-byte payload exposes ${ownKeyCount} own keys to the pre-fix walk; post-fix clone took ${elapsedMs.toFixed(2)} ms`,
    );
    check("the pre-fix implementation would have walked one own-key per byte", () => {
      assert.equal(ownKeyCount, 262_144);
    });
    check("the payload survives intact and the clone stays fast", () => {
      const payload = (cloned[0] as unknown as { details: { payload: Uint8Array } }).details
        .payload;
      assert.equal(payload.length, bytes.length);
      assert.equal(payload[0], 42);
      assert.ok(elapsedMs < 250, `clone took ${elapsedMs.toFixed(2)} ms`);
    });
  }

  if (failures > 0) {
    console.log(`\n${failures} runtime assertion(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll runtime assertions passed.");
  process.exit(0);
}

await main();
