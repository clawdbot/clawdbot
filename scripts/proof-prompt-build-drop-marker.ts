import { resolvePromptBuildHookResult } from "../src/agents/embedded-agent-runner/run/attempt.prompt-helpers.js";
/**
 * Real-runtime proof for openclaw-beads-201: "Runtime can still drop the
 * plans_and_tasks contribution without the agent knowing."
 *
 * A `before_prompt_build` contribution that the runtime discards leaves no hole
 * in the prompt. The agent sees a context that looks complete, so "my work
 * queue is empty" and "my work queue was lost" are indistinguishable. Every
 * host-side drop path now injects a short marker naming what was lost.
 *
 * WHAT IS REAL (no vitest, no mocks of the seam under test):
 *   - `createHookRunner` (src/plugins/hooks.ts) — the real dispatcher, including
 *     the real `beforePromptBuildDispatch` AsyncLocalStorage re-entrancy guard,
 *     the real per-hook modifying-hook timeout, and the real `handleHookError`
 *     fail-open path.
 *   - `initializeGlobalHookRunner` / `getGlobalHookRunner`
 *     (src/plugins/hook-runner-global.ts) — the real process singleton, with the
 *     real production options (catchErrors: true, before_prompt_build fail-open).
 *   - `resolveAgentHarnessBeforePromptBuildResult`
 *     (src/agents/harness/prompt-compaction-hook-helpers.ts) — one of the two
 *     real production prompt-build call sites. It returns the fully assembled
 *     prompt string, so scenarios driven through it prove the marker reaches the
 *     text handed to the model, not merely a field on a result object.
 *   - `resolvePromptBuildHookResult`
 *     (src/agents/embedded-agent-runner/run/attempt.prompt-helpers.ts) — the
 *     other real call site, shared by the embedded runner
 *     (attempt-prompt-assembly.ts) and the CLI runner (cli-runner/prepare.ts).
 *     Both append `appendContext` to the prompt verbatim
 *     (attempt-prompt-assembly.ts `effectivePrompt = ...appendContext`;
 *     cli-runner/prepare.ts `preparedPrompt = ...appendContext`), so asserting
 *     on `appendContext` here is asserting on prompt text.
 *   - `createEmptyPluginRegistry` (src/plugins/registry-empty.ts) — the real
 *     empty-registry factory.
 *
 * WHAT IS CONSTRUCTED RATHER THAN LOADED:
 *   - The plugin registrations. Loading a real npm plugin off disk would exercise
 *     the loader, which sits entirely upstream of the seam under test; the
 *     registration records below are the same `{pluginId, hookName, handler,
 *     priority, timeoutMs}` shape the loader produces. Nothing between the
 *     handler and the assembled prompt is stubbed.
 *
 * SCENARIOS:
 *   1. Healthy baseline — the block reaches the prompt and NO marker is added.
 *      (Without this, a marker that fires unconditionally would look like a pass.)
 *   2. Handler throw — the throwing plugin is named in the marker; a healthy
 *      plugin's contribution still survives.
 *   3. Handler timeout (per-hook `timeoutMs`) — marker carries the timeout text.
 *   4. Re-entrancy guard — a nested prompt build gets a marker naming every
 *      plugin whose contribution the guard skipped; the outer build stays clean.
 *   5. Dispatch rejection — a fail-closed runner makes `runBeforePromptBuild`
 *      itself reject; the call site's `.catch()` emits the marker.
 *
 * Every drop scenario also asserts the dropped plugin's own block is genuinely
 * absent, so the marker is never mistaken for the contribution surviving.
 *
 * RUN: pnpm tsx scripts/proof-prompt-build-drop-marker.ts
 */
import { resolveAgentHarnessBeforePromptBuildResult } from "../src/agents/harness/prompt-compaction-hook-helpers.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  initializeGlobalHookRunner,
  getGlobalHookRunner,
} from "../src/plugins/hook-runner-global.js";
import { createHookRunner } from "../src/plugins/hooks.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import type { PluginRegistry } from "../src/plugins/registry.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforePromptBuildResult,
  PluginHookRegistration,
} from "../src/plugins/types.js";

const MARKER_OPEN = '<dropped_plugin_context hook="before_prompt_build">';
const PLANS_BLOCK =
  "<plans_and_tasks><ready_issues><issue id='openclaw-beads-201'/></ready_issues></plans_and_tasks>";

let checks = 0;

function assert(condition: boolean, description: string): void {
  checks += 1;
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${description}`);
  }
  console.log(`  ok  ${description}`);
}

type HookSpec = {
  pluginId: string;
  handler: (
    event: { prompt: string; messages: unknown[] },
    ctx: PluginHookAgentContext,
  ) =>
    | Promise<PluginHookBeforePromptBuildResult | undefined>
    | PluginHookBeforePromptBuildResult
    | undefined;
  priority?: number;
  timeoutMs?: number;
};

/** Builds a real PluginRegistry carrying real before_prompt_build registrations. */
function buildRegistry(specs: HookSpec[]): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  for (const spec of specs) {
    registry.typedHooks.push({
      pluginId: spec.pluginId,
      hookName: "before_prompt_build",
      handler: spec.handler,
      priority: spec.priority ?? 0,
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      source: "proof",
    } as unknown as PluginHookRegistration);
  }
  return registry;
}

const cfg = {} as OpenClawConfig;

const hookCtx: PluginHookAgentContext = {
  runId: "proof-run",
  agentId: "tank",
  sessionKey: "agent:tank:main:heartbeat",
  sessionId: "proof-session",
  workspaceDir: "/tmp/openclaw-proof-201",
  trigger: "heartbeat",
  messageProvider: "slack",
};

/** Drives the harness call site, which returns the fully assembled prompt. */
async function runHarnessPromptBuild(): Promise<string> {
  const result = await resolveAgentHarnessBeforePromptBuildResult({
    prompt: "heartbeat wake",
    developerInstructions: "be useful",
    messages: [],
    ctx: {
      runId: hookCtx.runId,
      agentId: hookCtx.agentId,
      sessionKey: hookCtx.sessionKey,
      sessionId: hookCtx.sessionId,
      workspaceDir: hookCtx.workspaceDir,
      trigger: "heartbeat",
      messageProvider: "slack",
    },
  });
  return result.prompt;
}

/** Drives the embedded/CLI call site. */
async function runEmbeddedPromptBuild(runner: unknown): Promise<PluginHookBeforePromptBuildResult> {
  return await resolvePromptBuildHookResult({
    config: cfg,
    prompt: "heartbeat wake",
    messages: [],
    hookCtx,
    hookRunner: runner as Parameters<typeof resolvePromptBuildHookResult>[0]["hookRunner"],
  });
}

async function main(): Promise<void> {
  console.log("\n[1] healthy contribution reaches the prompt and adds NO marker");
  initializeGlobalHookRunner(
    buildRegistry([{ pluginId: "proof-beads", handler: () => ({ prependContext: PLANS_BLOCK }) }]),
  );
  const healthyPrompt = await runHarnessPromptBuild();
  assert(healthyPrompt.includes(PLANS_BLOCK), "healthy: block present in assembled prompt");
  assert(
    !healthyPrompt.includes(MARKER_OPEN),
    "healthy: no drop marker (marker is not unconditional)",
  );

  console.log("\n[2] throwing handler: marker names the plugin, healthy plugin survives");
  initializeGlobalHookRunner(
    buildRegistry([
      {
        pluginId: "proof-beads",
        priority: -20,
        handler: () => {
          throw new Error("bd ready --json failed in /repo after 4002ms");
        },
      },
      {
        pluginId: "proof-provenance",
        priority: 10,
        handler: () => ({ prependContext: "TAINT: trusted" }),
      },
    ]),
  );
  const throwPrompt = await runHarnessPromptBuild();
  assert(throwPrompt.includes(MARKER_OPEN), "throw: marker present in assembled prompt");
  assert(
    throwPrompt.includes("proof-beads (handler failed or timed out: bd ready --json failed"),
    "throw: marker names proof-beads and carries the error detail",
  );
  assert(!throwPrompt.includes("proof-provenance"), "throw: healthy plugin is not blamed");
  assert(throwPrompt.includes("TAINT: trusted"), "throw: healthy plugin's contribution survives");
  assert(!throwPrompt.includes(PLANS_BLOCK), "throw: dropped block really is absent");

  console.log("\n[3] handler timeout: marker carries the timeout text");
  initializeGlobalHookRunner(
    buildRegistry([
      {
        pluginId: "proof-beads",
        timeoutMs: 150,
        handler: () => new Promise<PluginHookBeforePromptBuildResult>(() => {}),
      },
    ]),
  );
  const timeoutResult = await runEmbeddedPromptBuild(getGlobalHookRunner());
  assert(
    (timeoutResult.appendContext ?? "").includes(MARKER_OPEN),
    "timeout: marker present in appendContext (appended to the prompt verbatim by both callers)",
  );
  assert(
    (timeoutResult.appendContext ?? "").includes(
      "proof-beads (handler failed or timed out: timed out after 150ms)",
    ),
    "timeout: marker names proof-beads and reports the 150ms budget",
  );
  assert(
    !(timeoutResult.prependContext ?? "").includes(PLANS_BLOCK),
    "timeout: dropped block really is absent",
  );

  console.log("\n[4] re-entrancy guard: nested prompt build is told what was skipped");
  let nested: PluginHookBeforePromptBuildResult | undefined;
  const reentrantRegistry = buildRegistry([
    {
      pluginId: "proof-beads",
      priority: -20,
      handler: async () => {
        // A plugin that starts a nested agent run from inside its own handler.
        nested = await runEmbeddedPromptBuild(getGlobalHookRunner());
        return { prependContext: PLANS_BLOCK };
      },
    },
    {
      pluginId: "proof-provenance",
      priority: 10,
      handler: () => ({ prependContext: "TAINT: trusted" }),
    },
  ]);
  initializeGlobalHookRunner(reentrantRegistry);
  const outer = await runEmbeddedPromptBuild(getGlobalHookRunner());
  assert(
    (outer.prependContext ?? "").includes(PLANS_BLOCK),
    "re-entrancy: outer prompt build still gets the block",
  );
  assert(
    !(outer.appendContext ?? "").includes(MARKER_OPEN),
    "re-entrancy: outer prompt build is not marked (nothing was dropped there)",
  );
  assert(nested !== undefined, "re-entrancy: nested prompt build ran");
  assert(
    (nested?.appendContext ?? "").includes(MARKER_OPEN),
    "re-entrancy: nested prompt build carries the marker",
  );
  assert(
    (nested?.appendContext ?? "").includes("proof-beads (skipped for a nested prompt build)") &&
      (nested?.appendContext ?? "").includes(
        "proof-provenance (skipped for a nested prompt build)",
      ),
    "re-entrancy: marker names every plugin the guard skipped",
  );
  assert(
    !(nested?.prependContext ?? "").includes(PLANS_BLOCK),
    "re-entrancy: nested prompt build really lost the block",
  );

  console.log("\n[5] dispatch rejection: the call site's .catch() emits the marker");
  const failClosedRunner = createHookRunner(
    buildRegistry([
      {
        pluginId: "proof-beads",
        handler: () => {
          throw new Error("registry exploded");
        },
      },
    ]),
    { catchErrors: false },
  );
  const rejectedResult = await runEmbeddedPromptBuild(failClosedRunner);
  assert(
    (rejectedResult.appendContext ?? "").includes(MARKER_OPEN),
    "dispatch-failed: marker present after runBeforePromptBuild rejected",
  );
  assert(
    (rejectedResult.appendContext ?? "").includes("hook dispatch failed"),
    "dispatch-failed: marker reports a dispatch failure",
  );
  assert(
    !(rejectedResult.prependContext ?? "").includes(PLANS_BLOCK),
    "dispatch-failed: dropped block really is absent",
  );

  console.log(`\nAll runtime assertions passed. (${checks} checks)`);
}

main().catch((error: unknown) => {
  console.error(`\nPROOF FAILED after ${checks} checks: ${String(error)}`);
  process.exitCode = 1;
});
