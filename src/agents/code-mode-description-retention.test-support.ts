import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { Type } from "typebox";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import { createAgentHarnessPromptToolPolicy } from "./harness/prompt-tool-policy.js";
import { Agent } from "./runtime/index.js";
import { createResourceLoader } from "./sessions/agent-session-loop-resource-loader.test-support.js";
import { AgentSession } from "./sessions/agent-session.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import type { ExtensionRunner } from "./sessions/extensions/runner.js";
import { ModelRegistry } from "./sessions/model-registry.js";
import { SessionManager } from "./sessions/session-manager.js";
import { SettingsManager } from "./sessions/settings-manager.js";
import { createToolDefinitionFromAgentTool } from "./sessions/tools/tool-definition-wrapper.js";
import { clearToolSearchCatalog, createToolSearchCatalogRef } from "./tool-search-catalog.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

async function collect() {
  const gc = globalThis.gc;
  assert.ok(gc, "The retention child requires --expose-gc");
  for (let pass = 0; pass < 8; pass += 1) {
    await setImmediate();
    gc();
  }
}

function createScenario() {
  const catalogRef = createToolSearchCatalogRef();
  const context = {
    config: { tools: { codeMode: true, toolSearch: false } },
    catalogRef,
    sessionId: "description-retention-session",
    sessionKey: "agent:main:description-retention",
    runId: "description-retention-run",
  };
  const targets: AnyAgentTool[] = ["allowed_target", "removed_target"].map((name) => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => jsonResult({ name }),
  }));
  const compacted = applyCodeModeCatalog({
    ...context,
    tools: [...createCodeModeTools(context), ...targets],
  });
  const exec = compacted.tools.find((tool) => tool.name === "exec");
  assert.ok(exec);
  const definition = createToolDefinitionFromAgentTool(exec);
  const resourceLoader = createResourceLoader();
  const extensionRunnerRef: { current?: ExtensionRunner } = {};
  const agent = new Agent({
    streamFn: () => {
      throw new Error("This lifecycle fixture must not invoke a provider");
    },
  });
  const session = new AgentSession({
    agent,
    cwd: process.cwd(),
    sessionManager: SessionManager.inMemory(process.cwd()),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    resourceLoader,
    customTools: [definition],
    initialActiveToolNames: ["exec"],
    allowedToolNames: ["exec"],
    disableBuiltInTools: true,
    baseToolsOverride: {},
    extensionRunnerRef,
  });
  function current() {
    const tool = agent.state.tools.find((item) => item.name === "exec");
    assert.ok(tool);
    return tool;
  }
  const wrappers = [new WeakRef(current())];
  assert.ok(extensionRunnerRef.current);
  const runners = [new WeakRef(extensionRunnerRef.current)];
  let held: ReturnType<typeof current> | undefined = current();
  return {
    wrappers,
    runners,
    refresh() {
      resourceLoader.getExtensions().runtime.refreshTools();
      wrappers.push(new WeakRef(current()));
    },
    async reload() {
      await session.reload();
      wrappers.push(new WeakRef(current()));
      assert.ok(extensionRunnerRef.current);
      runners.push(new WeakRef(extensionRunnerRef.current));
    },
    restrict() {
      createAgentHarnessPromptToolPolicy({
        tools: [definition],
        catalogRef,
        codeModeControlsEnabled: true,
      }).apply({ toolsAllow: ["allowed_target"] });
      assert.ok(held);
      for (const tool of [exec, definition, held, current()]) {
        assert.match(tool.description, /- allowed_target/);
        assert.doesNotMatch(tool.description, /- removed_target/);
      }
    },
    releaseHeld() {
      held = undefined;
    },
    dispose() {
      clearToolSearchCatalog(context);
      session.dispose();
    },
  };
}

let scenario: ReturnType<typeof createScenario> | undefined = createScenario();
try {
  scenario.refresh();
  await scenario.reload();
  await scenario.reload();
  scenario.restrict();
  const control = new WeakRef({ unowned: true });
  await collect();
  assert.equal(control.deref(), undefined, "Unowned control must collect");
  const [heldWrapper, refreshedWrapper, reloadedWrapper] = scenario.wrappers;
  const [heldRunner, replacedRunner] = scenario.runners;
  assert.ok(heldWrapper && refreshedWrapper && reloadedWrapper && heldRunner && replacedRunner);
  assert.equal(refreshedWrapper.deref(), undefined, "Replaced registry wrapper must collect");
  assert.equal(reloadedWrapper.deref(), undefined, "Reloaded registry wrapper must collect");
  assert.equal(replacedRunner.deref(), undefined, "Replaced extension runner must collect");
  assert.ok(heldWrapper.deref(), "Externally held wrapper remains usable");
  assert.ok(heldRunner.deref(), "Held wrapper still owns its execution context");
  scenario.releaseHeld();
  await collect();
  assert.equal(heldWrapper.deref(), undefined);
  assert.equal(heldRunner.deref(), undefined);
  const wrappers = scenario.wrappers;
  const runners = scenario.runners;
  scenario.dispose();
  scenario = undefined;
  await collect();
  assert.ok(wrappers.every((reference) => !reference.deref()));
  assert.ok(runners.every((reference) => !reference.deref()));
  process.stdout.write(
    JSON.stringify({ obsoleteWrappersReleased: true, liveDescriptionsSynchronized: true }),
  );
} finally {
  scenario?.dispose();
}
