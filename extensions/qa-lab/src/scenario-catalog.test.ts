// Qa Lab tests cover scenario catalog plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveQaParityPackScenarioIds } from "./agentic-parity.js";
import { resolveQaRepoPath } from "./repo-path.js";
import {
  listQaScenarioYamlPaths,
  readQaBootstrapScenarioCatalog,
  readQaScenarioById,
  readQaScenarioExecutionConfig,
  readQaScenarioPack,
} from "./scenario-catalog.js";
import {
  flowContainsCall,
  isFlowScenario,
  listScenarioMarkdownPaths,
  requireFlowScenario,
} from "./scenario-catalog.test-utils.js";
import { applyQaMergePatch } from "./suite-merge-patch.js";
import { runQaTestFileScenarios } from "./test-file-scenario-runner.js";

describe("qa scenario catalog", () => {
  const twoPartCoverageIdPattern = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
  const agentRuntime = "agent-runtime";
  const browserUi = "control-ui";
  const cli = "cli";
  const codex = "openai";
  const memory = "session-memory";
  const otel = "observability";

  it("keeps repo-backed scenarios YAML-only", () => {
    expect(listScenarioMarkdownPaths()).toStrictEqual([]);
  });

  it("loads the YAML pack as the canonical source of truth", () => {
    const pack = readQaScenarioPack();

    expect(pack.version).toBe(1);
    expect(pack.agent.identityMarkdown).toContain("Dev C-3PO");
    expect(pack.kickoffTask).toContain("Lobster Invaders");
    expect(listQaScenarioYamlPaths().length).toBe(pack.scenarios.length);
    expect(listQaScenarioYamlPaths()).toContain(
      "qa/scenarios/media/image-generation-roundtrip.yaml",
    );
    const scenarioIds = pack.scenarios.map((scenario) => scenario.id);
    const requiredScenarioIds = [
      "image-generation-roundtrip",
      "character-vibes-gollum",
      "character-vibes-c3po",
    ].toSorted();
    expect(
      scenarioIds.filter((scenarioId) => requiredScenarioIds.includes(scenarioId)).toSorted(),
    ).toEqual(requiredScenarioIds);
    const nativeExecutionScenarios = pack.scenarios.filter(
      (scenario) => scenario.execution.kind !== "flow",
    );
    expect(nativeExecutionScenarios.length).toBeGreaterThan(0);
    for (const scenario of nativeExecutionScenarios) {
      const execution = scenario.execution;
      if (execution.kind === "flow") {
        throw new Error(`expected native execution scenario: ${scenario.id}`);
      }
      expect(["playwright", "script", "vitest"]).toContain(execution.kind);
      expect(fs.existsSync(execution.path), `${scenario.id} execution.path exists`).toBe(true);
      expect(execution.flow).toBeUndefined();
    }
    expect(
      pack.scenarios
        .filter((scenario) => scenario.execution.kind === "flow")
        .every((scenario) => (scenario.execution.flow?.steps.length ?? 0) > 0),
    ).toBe(true);
    expect(
      pack.scenarios
        .filter(
          (scenario) => !scenario.coverage?.primary.length && !scenario.coverage?.secondary?.length,
        )
        .map((scenario) => scenario.id),
    ).toStrictEqual([]);
    expect(
      pack.scenarios.every(
        (scenario) =>
          (scenario.coverage?.primary ?? []).every((coverageId) =>
            twoPartCoverageIdPattern.test(coverageId),
          ) &&
          (scenario.coverage?.secondary ?? []).every((coverageId) =>
            twoPartCoverageIdPattern.test(coverageId),
          ),
      ),
    ).toBe(true);
    const recall = readQaScenarioById("memory-recall");
    expect(recall.coverage?.primary).toContain(`${memory}.memory-recall`);
  });

  it("keeps scenario documentation and code references backed by the repository", () => {
    for (const scenario of readQaScenarioPack().scenarios) {
      const referenceGroups = [
        ["docsRefs", scenario.docsRefs],
        ["codeRefs", scenario.codeRefs],
      ] as const;

      for (const [kind, references] of referenceGroups) {
        for (const reference of references ?? []) {
          const resolvedReference =
            resolveQaRepoPath(import.meta.dirname, reference, "file") ??
            resolveQaRepoPath(import.meta.dirname, reference, "directory");
          expect(resolvedReference, `${scenario.id} ${kind} ${reference} exists`).not.toBeNull();
        }
      }
    }
  });

  it("exposes bootstrap data from the YAML pack", () => {
    const catalog = readQaBootstrapScenarioCatalog();

    expect(catalog.agentIdentityMarkdown).toContain("protocol-minded");
    expect(catalog.kickoffTask).toContain("Track what worked");
    const scenarioIds = catalog.scenarios.map((scenario) => scenario.id);
    expect(scenarioIds).toContain("subagent-fanout-synthesis");
    expect(
      resolveQaParityPackScenarioIds({ parityPack: "agentic" }).filter(
        (scenarioId) => !scenarioIds.includes(scenarioId),
      ),
    ).toStrictEqual([]);
  });

  it("loads scenario-specific execution config from per-scenario YAML", () => {
    const discovery = readQaScenarioById("source-docs-discovery-report");
    const discoveryConfig = readQaScenarioExecutionConfig("source-docs-discovery-report");
    const fallbackConfig = readQaScenarioExecutionConfig("memory-failure-fallback");
    const bundledSkill = readQaScenarioById("bundled-plugin-skill-runtime");
    const bundledSkillConfig = readQaScenarioExecutionConfig("bundled-plugin-skill-runtime") as
      | { pluginId?: string; expectedSkillName?: string }
      | undefined;
    const fanoutConfig = readQaScenarioExecutionConfig("subagent-fanout-synthesis") as
      | { expectedReplyGroups?: unknown[][] }
      | undefined;

    expect(discovery.title).toBe("Source and docs discovery report");
    expect((discoveryConfig?.requiredFiles as string[] | undefined)?.[0]).toBe(
      "repo/qa/scenarios/index.yaml",
    );
    expect(fallbackConfig).not.toHaveProperty("gracefulFallbackAny");
    const fallbackFlow = JSON.stringify(
      readQaScenarioById("memory-failure-fallback").execution.flow,
    );
    expect(fallbackFlow).toContain("liveTurnTimeoutMs(env, 180000)");
    expect(fallbackFlow).toContain('"replacePaths":["tools.deny"]');
    expect(fallbackFlow).toContain("!tools.has('memory_search')");
    expect(fallbackFlow).toContain("outbound.text.trim().length > 0");
    expect(bundledSkill.title).toBe("Bundled plugin skill runtime");
    expect(bundledSkillConfig?.pluginId).toBe("open-prose");
    expect(bundledSkillConfig?.expectedSkillName).toBe("prose");
    expect(fanoutConfig?.expectedReplyGroups?.flat()).toContain("subagent-1: ok");
    expect(fanoutConfig?.expectedReplyGroups?.flat()).toContain("subagent-2: ok");
  });

  it("loads explicit suite isolation metadata from per-scenario YAML", () => {
    const staleLinks = requireFlowScenario(readQaScenarioById("subagent-stale-child-links"));
    const kitchenSink = requireFlowScenario(readQaScenarioById("kitchen-sink-live-openai"));
    const cronRestart = requireFlowScenario(
      readQaScenarioById("cron-model-created-one-shot-recurring"),
    );
    const cronAuthority = requireFlowScenario(
      readQaScenarioById("cron-model-created-explicit-authority"),
    );

    expect(staleLinks.execution.suiteIsolation).toBe("isolated");
    expect(staleLinks.execution.isolationReason).toContain("gateway session");
    expect(kitchenSink.execution.suiteIsolation).toBe("isolated");
    expect(kitchenSink.execution.isolationReason).toContain("plugin/channel/tool config");
    expect(cronRestart.execution.suiteIsolation).toBe("isolated");
    expect(cronRestart.execution.retryCount).toBe(0);
    expect(JSON.stringify(cronRestart.execution.flow)).toContain("liveTurnTimeoutMs(env, 180000)");
    expect(cronAuthority.execution.suiteIsolation).toBe("isolated");
    expect(cronAuthority.execution.retryCount).toBe(0);
    expect(cronAuthority.runtimePairLane).toBe("core");
    expect(cronAuthority.execution.config).toMatchObject({
      requiredProviderMode: "live-frontier",
    });
    expect(JSON.stringify(cronAuthority.gatewayConfigPatch)).toContain(
      "qa-cron-authority-operator",
    );
    const cronAuthorityFlow = JSON.stringify(cronAuthority.execution.flow);
    expect(cronAuthorityFlow).toContain("toolsAllowIsDefault");
    expect(cronAuthorityFlow).toContain("model did not submit the wildcard-policy job");
    expect(cronAuthorityFlow).toContain("model did not submit the overbroad-policy job");
    expect(cronAuthorityFlow).toContain("overbroad policy was not intersected");
    expect(cronAuthorityFlow).not.toContain("cron.run");
    expect(cronAuthorityFlow).not.toContain("waitForCronRunCompletion");
  });

  it("requires explicit suite isolation for gateway state restart scenarios", () => {
    const scenarios = readQaScenarioPack()
      .scenarios.filter(isFlowScenario)
      .filter((scenario) =>
        flowContainsCall(scenario.execution.flow, "env.gateway.restartAfterStateMutation"),
      );

    expect(scenarios.map((scenario) => scenario.id).toSorted()).toEqual([
      "active-memory-preprompt-recall",
      "cron-model-created-explicit-authority",
      "cron-model-created-one-shot-recurring",
      "kitchen-sink-live-openai",
      "matrix-post-restart-room-continue",
      "matrix-restart-resume",
      "qa-channel-reconnect-dedupe",
      "remember-across-conversations",
      "slack-restart-resume",
      "subagent-stale-child-links",
      "telegram-repeated-command-authorization",
      "whatsapp-restart-resume",
    ]);
    expect(
      scenarios
        .filter((scenario) => scenario.execution.suiteIsolation !== "isolated")
        .map((scenario) => scenario.id),
    ).toEqual([]);
  });

  it("uses graceful restart and isolation for Matrix replay dedupe", () => {
    const scenario = requireFlowScenario(readQaScenarioById("matrix-restart-replay-dedupe"));
    const staleSync = requireFlowScenario(readQaScenarioById("matrix-stale-sync-replay-dedupe"));

    expect(flowContainsCall(scenario.execution.flow, "env.gateway.restart")).toBe(true);
    expect(flowContainsCall(scenario.execution.flow, "env.gateway.restartAfterStateMutation")).toBe(
      false,
    );
    expect(staleSync.execution.suiteIsolation).toBe("isolated");
  });

  it("loads scenario-declared gateway runtime options from YAML", () => {
    const scenario = readQaScenarioById("control-ui-qa-channel-image-roundtrip");
    const otelStdout = readQaScenarioById("otel-stdout-log-smoke");
    const blockedSlack = readQaScenarioById("slack-blocked-lifecycle-no-restart");

    expect(scenario.gatewayRuntime?.forwardHostHome).toBe(true);
    expect(otelStdout.gatewayRuntime?.preserveDebugArtifacts).toBe(true);
    expect(blockedSlack.gatewayRuntime?.allowUnhealthyStartup).toBe(true);
  });

  it.each([
    ["otel-trace-smoke", { diagnostics: { otel: { captureContent: false } } }, []],
    ["otel-both-log-smoke", { diagnostics: { otel: { captureContent: false } } }, []],
    ["otel-stdout-log-smoke", { diagnostics: { otel: { captureContent: false } } }, []],
    [
      "a2a-message-tool-mirror-dedupe",
      {
        messages: { groupChat: { visibleReplies: "message_tool" } },
        tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
      },
      ["session.agentToAgent"],
    ],
    [
      "goal-context-survives-compaction",
      { agents: { defaults: { compaction: { keepRecentTokens: 64 } } } },
      ["agents.defaults.compaction.reserveTokens", "agents.defaults.compaction.reserveTokensFloor"],
    ],
    [
      "commitments-heartbeat-target-none",
      { agents: { defaults: { heartbeat: { every: "30m", target: "none" } } } },
      ["commitments"],
    ],
    [
      "active-memory-preprompt-recall",
      { plugins: { entries: { "active-memory": { config: { mode: "always" } } } } },
      [],
    ],
  ] as const)(
    "keeps %s gateway config canonical and free of retired keys",
    (scenarioId, expectedPatch, retiredPaths) => {
      const gatewayConfigPatch = readQaScenarioById(scenarioId).gatewayConfigPatch;
      const gatewayConfig = applyQaMergePatch(
        { agents: { entries: { qa: { default: true } } } },
        gatewayConfigPatch,
      );

      expect(gatewayConfigPatch).toMatchObject(expectedPatch);
      expect(gatewayConfig).toMatchObject(expectedPatch);
      for (const retiredPath of retiredPaths) {
        expect(gatewayConfigPatch).not.toHaveProperty(retiredPath);
      }
    },
  );

  it("keeps session memory ranking's runtime config patch canonical", () => {
    const scenario = readQaScenarioById("session-memory-ranking");
    const patchConfigAction = scenario.execution.flow?.steps
      .flatMap((step) => step.actions)
      .find(
        (action): action is { call: "patchConfig"; args: Array<{ patch: unknown }> } =>
          typeof action === "object" &&
          action !== null &&
          "call" in action &&
          action.call === "patchConfig" &&
          "args" in action &&
          Array.isArray(action.args),
      );
    const patch = patchConfigAction?.args[0]?.patch;

    expect(patch).toMatchObject({
      tools: { sessions: { visibility: "all" } },
      memory: {
        search: {
          sources: ["memory", "sessions"],
          experimental: { sessionMemory: true },
          query: { minScore: 0 },
        },
      },
    });
    expect(patch).not.toHaveProperty("memory.search.query.hybrid");
  });

  it("loads native test execution scenarios from YAML", () => {
    const scenario = readQaScenarioById("control-ui-chat-flow-playwright");
    const otelSmoke = readQaScenarioById("qa-otel-smoke");

    expect(scenario.execution.kind).toBe("playwright");
    if (scenario.execution.kind !== "playwright") {
      throw new Error(`expected Playwright scenario, got ${scenario.execution.kind}`);
    }
    expect(scenario.execution.path).toBe("ui/src/e2e/chat-flow.messaging.e2e.test.ts");
    expect(scenario.execution.testNamePattern).toBe(
      "sends a chat turn through the GUI and renders the final Gateway event",
    );
    expect(scenario.execution.flow).toBeUndefined();
    expect(scenario.coverage?.secondary).toContain(`${browserUi}.gateway-hosted-ui-control`);
    expect(otelSmoke.execution.kind).toBe("script");
    if (otelSmoke.execution.kind !== "script") {
      throw new Error(`expected script scenario, got ${otelSmoke.execution.kind}`);
    }
    expect(otelSmoke.execution.args).toStrictEqual([
      "--output-dir",
      "${outputDir}",
      "--logs-exporter",
      "both",
    ]);
    expect(otelSmoke.coverage?.secondary).not.toContain(`${otel}.otlp-http-traces-qa-lab`);
  });

  it("reserves Gateway-hosted Control UI proof for the real Gateway flow", () => {
    const coverageId = `${browserUi}.gateway-hosted-ui-control`;
    const primaryOwnerIds = readQaScenarioPack()
      .scenarios.filter((scenario) => scenario.coverage?.primary.includes(coverageId))
      .map((scenario) => scenario.id);
    expect(primaryOwnerIds).toStrictEqual(["control-ui-qa-channel-image-roundtrip"]);

    for (const scenario of [
      readQaScenarioById("control-ui-chat-flow-playwright"),
      readQaScenarioById("control-ui-plan-replay-reconnect"),
    ]) {
      expect(scenario.execution.kind, scenario.id).toBe("playwright");
      expect(scenario.coverage?.primary, scenario.id).not.toContain(coverageId);
      expect(scenario.coverage?.secondary, scenario.id).toContain(coverageId);
    }

    const hostedScenario = readQaScenarioById("control-ui-qa-channel-image-roundtrip");
    expect(hostedScenario.execution).toMatchObject({ kind: "flow", channel: "qa-channel" });
    expect(hostedScenario.coverage?.primary).toContain(coverageId);
  });

  // oxfmt-ignore
  it.each([
    [`${agentRuntime}.progress-visibility-failure-recovery`, "empty-response-retry-budget-exhausted", "empty-response-recovery-replay-safe-read"],
    [`${agentRuntime}.failure-recovery-retry-policy`, "empty-response-recovery-replay-safe-read", "reasoning-only-no-auto-retry-after-write"],
  ] as const)("keeps %s on its canonical primary owner", (coverageId, primaryOwnerId, secondaryScenarioId) => {
    const primaryOwnerIds = readQaScenarioPack().scenarios.filter((scenario) => scenario.coverage?.primary.includes(coverageId)).map((scenario) => scenario.id);
    const secondaryScenario = readQaScenarioById(secondaryScenarioId);
    expect(primaryOwnerIds, coverageId).toStrictEqual([primaryOwnerId]); expect(secondaryScenario.coverage?.primary, secondaryScenarioId).not.toContain(coverageId);
    expect(secondaryScenario.coverage?.secondary, secondaryScenarioId).toContain(coverageId);
  });

  it("loads helper-backed HTTP API scenarios as supporting taxonomy coverage", () => {
    expect(readQaScenarioById("openai-compatible-chat-tools").coverage?.secondary).toStrictEqual([
      "gateway.openai-compatible-apis",
      `${agentRuntime}.hosted-tool-use`,
    ]);
    expect(readQaScenarioById("openai-web-search-minimal").coverage?.secondary).toEqual(
      expect.arrayContaining([
        `${agentRuntime}.reasoning-and-cache-controls`,
        "web-search.openai-native-web-search",
        "plugins.web-search-and-fetch",
      ]),
    );
    const webuiCoverage = readQaScenarioById("openwebui-openai-compatible").coverage?.secondary;
    expect(webuiCoverage).toContain("gateway.openai-compatible-apis");
    expect(webuiCoverage).toContain(`${agentRuntime}.hosted-provider-turns`);
  });

  it("routes Docker runtime scenarios through the shared lane adapter", () => {
    const scenarioLanes = [
      ["codex-plugin-cold-install", "codex-on-demand"],
      ["openai-compatible-chat-tools", "openai-chat-tools"],
      ["openai-web-search-minimal", "openai-web-search-minimal"],
      ["openwebui-openai-compatible", "openwebui"],
      ["plugin-lifecycle-probe", "plugin-lifecycle-matrix"],
      ["packaged-bundled-plugin-install-uninstall", "bundled-plugin-install-uninstall"],
    ] as const;

    for (const [scenarioId, lane] of scenarioLanes) {
      const execution = readQaScenarioById(scenarioId).execution;
      expect(execution.kind).toBe("script");
      if (execution.kind !== "script") {
        throw new Error(`expected script scenario, got ${execution.kind}`);
      }
      expect(execution.path).toBe("test/e2e/qa-lab/runtime/docker-e2e-lane.ts");
      expect(execution.args).toStrictEqual(["--lane", lane]);
    }
  });

  it("loads canonical runtime-pair lane metadata", () => {
    const firstHour = readQaScenarioById("runtime-first-hour-20-turn");
    const soak = readQaScenarioById("runtime-soak-100-turn");

    expect(firstHour.runtimePairLane).toBe("core");
    expect(readQaScenarioExecutionConfig(firstHour.id)).toMatchObject({
      runtimeParityComparison: "outcome-only",
      turnCount: 20,
    });
    expect(soak.runtimePairLane).toBe("soak");
    expect(readQaScenarioExecutionConfig(soak.id)).toMatchObject({ turnCount: 100 });
  });

  it("marks only non-assistant runtime parity fixtures as usage not applicable", () => {
    const notApplicable = readQaScenarioPack()
      .scenarios.filter((scenario) => scenario.runtimeParityUsage?.expectation === "not-applicable")
      .map((scenario) => scenario.id)
      .toSorted();

    expect(notApplicable).toStrictEqual(
      [
        "codex-plugin-cold-install",
        "codex-plugin-pinned-new",
        "codex-plugin-pinned-old",
      ].toSorted(),
    );
    for (const scenarioId of notApplicable) {
      const scenario = readQaScenarioById(scenarioId);
      expect(scenario.runtimePairLane).toBeDefined();
      expect(scenario.runtimeParityUsage).toMatchObject({
        expectation: "not-applicable",
      });
      if (scenario.runtimeParityUsage?.expectation === "not-applicable") {
        expect(scenario.runtimeParityUsage.reason).toContain("no assistant turn runs");
      }
    }
    expect(readQaScenarioById("runtime-tool-fs-read").runtimeParityUsage).toBeUndefined();
    expect(readQaScenarioById("plugin-hook-health-sentinel").runtimeParityUsage).toBeUndefined();
  });

  it("loads runtime tool fixture metadata for core and extended lanes", () => {
    const applyPatch = readQaScenarioById("runtime-tool-apply-patch");
    const sessionsSpawn = readQaScenarioById("runtime-tool-sessions-spawn");
    const messageTool = readQaScenarioById("runtime-tool-message-tool");
    const tavilySearch = readQaScenarioById("runtime-tool-tavily-search");
    const webFetch = readQaScenarioById("runtime-tool-web-fetch");
    const webSearch = readQaScenarioById("runtime-tool-web-search");
    const imageGenerate = readQaScenarioById("runtime-tool-image-generate");

    expect(applyPatch.runtimePairLane).toBe("core");
    for (const scenarioId of [
      "runtime-tool-apply-patch",
      "runtime-tool-bash",
      "runtime-tool-edit",
      "runtime-tool-exec",
      "runtime-tool-fs-list",
      "runtime-tool-fs-read",
      "runtime-tool-fs-write",
      "runtime-tool-grep",
    ]) {
      const nativeWorkspaceScenario = readQaScenarioById(scenarioId);
      expect(nativeWorkspaceScenario.coverage?.primary, scenarioId).toEqual([]);
      expect(nativeWorkspaceScenario.coverage?.secondary?.length, scenarioId).toBeGreaterThan(0);
    }
    expect(sessionsSpawn.coverage?.primary).toEqual([
      "agent-runtime.subagent-turns-sessions-spawn",
    ]);
    expect(messageTool.runtimePairLane).toBe("extended");
    expect(tavilySearch.runtimePairLane).toBe("extended");
    expect(imageGenerate.runtimePairLane).toBe("extended");
    expect(readQaScenarioExecutionConfig(applyPatch.id)).toMatchObject({
      toolName: "apply_patch",
      toolCoverage: {
        bucket: "codex-native-workspace",
        expectedLayer: "codex-native-workspace",
        required: true,
      },
    });
    expect(readQaScenarioExecutionConfig(applyPatch.id)).not.toHaveProperty("knownHarnessGap");
    expect(readQaScenarioExecutionConfig(applyPatch.id)?.happyPrompt).toContain(
      "runtime-tool-fixture-patch.txt",
    );
    expect(readQaScenarioExecutionConfig(applyPatch.id)?.failurePrompt).toContain(
      "../runtime-tool-fixture-denied.txt",
    );
    expect(readQaScenarioExecutionConfig(applyPatch.id)?.failurePrompt).toContain(
      "runtime-tool-fixture-denied-original",
    );
    expect(readQaScenarioExecutionConfig(applyPatch.id)?.failurePrompt).toContain(
      "runtime patch outside the workspace",
    );
    expect(readQaScenarioExecutionConfig(applyPatch.id)?.failurePrompt).not.toContain(
      "missing-context",
    );
    expect(readQaScenarioExecutionConfig(messageTool.id)).toMatchObject({
      toolName: "message",
      expectedAvailable: false,
      toolCoverage: {
        bucket: "optional-profile-or-plugin",
        expectedLayer: "profile-or-plugin",
        required: false,
      },
    });
    expect(readQaScenarioExecutionConfig(webSearch.id)).toMatchObject({
      toolName: "web_search",
      toolCoverage: {
        bucket: "openclaw-dynamic-integration",
        expectedLayer: "openclaw-dynamic",
        capabilityLayer: "openclaw-dynamic-direct",
        required: true,
      },
    });
    expect(readQaScenarioExecutionConfig(sessionsSpawn.id)).toMatchObject({
      toolName: "sessions_spawn",
      toolCoverage: {
        bucket: "openclaw-dynamic-integration",
        expectedLayer: "openclaw-dynamic",
        capabilityLayer: "openclaw-dynamic-direct",
        required: true,
      },
    });
    expect(readQaScenarioExecutionConfig(sessionsSpawn.id)).not.toHaveProperty("knownHarnessGap");
    const webFetchConfig = readQaScenarioExecutionConfig(webFetch.id);
    expect(webFetchConfig?.happyPrompt).toContain("Call web_fetch exactly once");
    expect(webFetchConfig?.happyPrompt).toContain("call it directly without tool_search");
    expect(webFetchConfig?.happyPrompt).toContain("Otherwise use tool_search to locate it first");
    expect(webFetchConfig?.happyPrompt).toContain(
      "A tool_search result alone does not complete the task",
    );
    expect(webFetchConfig?.happyPrompt).toContain("https://example.com/");
    expect(webFetchConfig?.happyPrompt).toContain("maxChars 500");
    expect(webFetchConfig?.happyPrompt).toContain("tool search qa check target=web_fetch");
    expect(webSearch.plugins).toEqual(["qa-lab"]);
    expect(webSearch.gatewayConfigPatch?.tools).toEqual({
      web: {
        search: {
          enabled: true,
          provider: "qa-lab-search",
        },
      },
    });
    expect(readQaScenarioExecutionConfig(webSearch.id)).not.toHaveProperty("knownHarnessGap");
    expect(readQaScenarioExecutionConfig(imageGenerate.id)).toMatchObject({
      requiredProviderMode: "mock-openai",
      toolName: "image_generate",
      toolCoverage: {
        bucket: "openclaw-dynamic-integration",
        expectedLayer: "openclaw-dynamic",
        capabilityLayer: "openclaw-dynamic-direct",
        required: false,
      },
    });
  });

  it("loads the Codex legacy Read vocabulary live parity canary", () => {
    const scenario = readQaScenarioById("codex-legacy-read-tool-vocabulary");
    const config = readQaScenarioExecutionConfig(scenario.id) as
      | {
          runtimeParityComparison?: string;
          fixtureFile?: string;
          expectedMarker?: string;
          unavailableNeedles?: string[];
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/runtime/codex-legacy-read-tool-vocabulary.yaml");
    expect(scenario.runtimePairLane).toBe("core");
    expect(config).toMatchObject({ requiredProviderMode: "live-frontier" });
    expect(config?.runtimeParityComparison).toBe("codex-native-workspace");
    expect(config?.fixtureFile).toBe("LEGACY_READ_TOOL_FIXTURE.txt");
    expect(config?.expectedMarker).toBe("LEGACY_READ_TOOL_OK");
    expect(config?.unavailableNeedles).toContain("not in my available tool surface");
  });

  it("loads the Matrix room block streaming provider override", () => {
    expect(readQaScenarioById("matrix-room-block-streaming").execution).toMatchObject({
      kind: "flow",
      providerMode: "mock-openai",
      retryCount: 0,
      timeoutMs: 75_000,
    });
  });

  it("loads live gateway sentinel scenarios for harness self-health", () => {
    const scenarioIds = [
      "plugin-hook-health-sentinel",
      "plugin-manifest-contract-health",
      "webchat-direct-reply-routing",
      "long-context-progress-watchdog",
      "gateway-restart-inflight-run",
      "gateway-restart-multi-live",
      "streaming-final-integrity",
    ];

    for (const scenarioId of scenarioIds) {
      const scenario = readQaScenarioById(scenarioId);
      expect(scenario.execution.flow?.steps.length).toBeGreaterThan(0);
      expect(scenario.coverage?.primary.length).toBeGreaterThan(0);
    }
    expect(readQaScenarioById("webchat-direct-reply-routing").sourcePath).toBe(
      "qa/scenarios/channels/webchat-direct-reply-routing.yaml",
    );
    expect(readQaScenarioById("long-context-progress-watchdog").sourcePath).toBe(
      "qa/scenarios/runtime/long-context-progress-watchdog.yaml",
    );
    const gatewayRestartFlow = readQaScenarioById("gateway-restart-inflight-run").execution.flow;
    const gatewayRestartContract = JSON.stringify(gatewayRestartFlow);
    expect(
      JSON.stringify(readQaScenarioById("gateway-restart-inflight-run").gatewayConfigPatch),
    ).toContain('"alsoAllow":["qa_restart_wait","qa_restart_unsafe_probe"]');
    expect(gatewayRestartContract).toContain("plannedToolName === 'wait'");
    expect(gatewayRestartContract).toContain("lastAssistantToolNames?.includes('wait')");
    expect(gatewayRestartContract).toContain("restartRecoveryDeliveryContext");
    expect(gatewayRestartContract).toContain("sendInbound");
    expect(gatewayRestartContract).not.toContain("startAgentRun");
    expect(gatewayRestartContract).toContain('"restartGatewayWithConfigPatch"');
    expect(gatewayRestartContract).toContain("interruptedMatches.length === 1");
    expect(gatewayRestartContract).toContain("restartNotices.length === 0");
    expect(gatewayRestartContract).toContain("dispatching restart-safe recovery");
    expect(gatewayRestartContract).toContain("[OpenClaw heartbeat poll]");
    expect(gatewayRestartContract).toContain("liveTurnTimeoutMs(env, 180000)");
    expect(gatewayRestartContract).toContain("id: `dm:${conversationId}`");
    expect(gatewayRestartContract).toContain("dmScope: env.cfg.session?.dmScope");
    expect(readQaScenarioById("gateway-restart-inflight-run").gatewayConfigPatch).toMatchObject({
      plugins: {
        slots: { memory: "none" },
        entries: {
          acpx: { enabled: false },
          "memory-core": { enabled: false },
        },
      },
    });
    const liveMultiRestart = readQaScenarioById("gateway-restart-multi-live");
    const liveMultiRestartContract = JSON.stringify(liveMultiRestart.execution.flow);
    expect(JSON.stringify(liveMultiRestart.gatewayConfigPatch)).toContain(
      '"alsoAllow":["qa_restart_wait","qa_restart_unsafe_probe"]',
    );
    expect(liveMultiRestartContract).toContain("assistantToolCallCounts.exec");
    expect(liveMultiRestartContract).toContain("checkpoint");
    expect(liveMultiRestartContract).toContain("restarts=3");
    expect(liveMultiRestartContract).toContain("dmScope: 'per-channel-peer'");
    expect(liveMultiRestartContract).toContain("dispatching restart-safe recovery");
    expect(readQaScenarioExecutionConfig("gateway-restart-multi-live")).toMatchObject({
      requiredProviderMode: "live-frontier",
      requiredProvider: "openai",
      requiredModel: "gpt-5.4",
    });
  });

  it("loads the QA bus tool trace visibility harness scenario", () => {
    const scenario = readQaScenarioById("qa-bus-tool-trace-visibility");
    const config = readQaScenarioExecutionConfig(scenario.id) as
      | {
          expectedToolName?: string;
          expectedRedaction?: string;
          searchQuery?: string;
        }
      | undefined;
    const claims = scenario.coverage;

    expect(claims?.primary).toContain(`${otel}.telemetry-tool-trace-visibility`);
    expect(claims?.secondary ?? []).toStrictEqual([
      `${otel}.telemetry-qa-bus`,
      `${otel}.telemetry-trace`,
    ]);
    expect(config?.expectedToolName).toBe("exec");
    expect(config?.expectedRedaction).toBe("[redacted]");
    expect(config?.searchQuery).toBe("exec");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "preserves searchable sanitized tool-call traces",
    ]);
  });

  it("loads the opt-in update.run package self-upgrade script proof", () => {
    const scenario = readQaScenarioById("update-run-package-self-upgrade");

    expect(scenario.coverage?.primary).toEqual([
      `${cli}.update-status-and-rpc`,
      "gateway.update-and-setup-apis",
    ]);
    expect(scenario.coverage?.secondary).toEqual([`${cli}.managed-gateway-restart`]);
    expect(scenario.execution.kind).toBe("script");
    if (scenario.execution.kind !== "script") {
      throw new Error(`expected script execution, got ${scenario.execution.kind}`);
    }
    expect(scenario.execution.path).toBe(
      "test/e2e/qa-lab/runtime/update-run-package-self-upgrade.ts",
    );
    expect(scenario.execution.allowBlockedEvidence).toBe(true);
    expect(scenario.execution.timeoutMs).toBe(3_600_000);
    expect(scenario.execution.args).toEqual(["--artifact-base", "${outputDir}"]);
    expect(scenario.execution.flow).toBeUndefined();
  });

  it("keeps the update.run producer blocked without destructive opt-in", async () => {
    const outputDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "openclaw-update-run-blocked-"),
    );
    try {
      const result = await runQaTestFileScenarios({
        repoRoot: process.cwd(),
        outputDir,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        scenarios: [readQaScenarioById("update-run-package-self-upgrade")],
        env: {
          OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF: "0",
          OPENCLAW_QA_REF: "blocked-evidence-test",
        },
      });

      expect(result.results[0]).toMatchObject({
        status: "blocked",
        producerEvidence: {
          entries: [
            {
              test: { id: "update-run-package-self-upgrade" },
              result: {
                status: "blocked",
                failure: {
                  reason:
                    "blocked destructive package self-upgrade; set OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF=1 to run",
                },
              },
            },
          ],
        },
      });
    } finally {
      await fs.promises.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("loads Codex plugin lifecycle scenarios into the core runtime-pair lane", () => {
    const coldInstall = readQaScenarioById("codex-plugin-cold-install");
    expect(coldInstall.runtimePairLane).toBe("core");
    expect(coldInstall.coverage?.primary).toEqual(["plugins.lifecycle-hot-install"]);
    expect(coldInstall.coverage?.secondary).toBeUndefined();
    expect(coldInstall.execution.kind).toBe("script");

    const fixtureScenarioIds = ["codex-plugin-pinned-old", "codex-plugin-pinned-new"];

    for (const scenarioId of fixtureScenarioIds) {
      const scenario = readQaScenarioById(scenarioId);
      expect(scenario.runtimePairLane).toBe("core");
      expect(scenario.coverage?.primary.length).toBeGreaterThan(0);
      expect(scenario.execution.flow?.steps.length).toBe(1);
    }
    expect(readQaScenarioExecutionConfig("codex-plugin-pinned-old")).toMatchObject({
      pluginVersion: "2026.5.19",
      hostVersion: "2026.5.21",
      pluginRelation: "older",
    });
  });

  it("routes the Codex doctor migration row through the product-backed Vitest", () => {
    const scenario = readQaScenarioById("auth-profile-doctor-migration-safety");

    expect(scenario.runtimePairLane).toBeUndefined();
    expect(scenario.runtimeParityUsage).toBeUndefined();
    expect(scenario.execution).toMatchObject({
      kind: "vitest",
      path: "test/e2e/qa-lab/runtime/codex-auth-doctor-migration-product-proof.e2e.test.ts",
    });
    expect(scenario.coverage?.primary).toEqual([`${codex}.codex-oauth-profiles-doctor-repair`]);
    expect(scenario.coverage?.secondary).toEqual([`${otel}.doctor-codex-plugin-auth`]);
  });

  it("routes the Codex mixed-profile row through the product-backed Vitest", () => {
    const scenario = readQaScenarioById("auth-profile-codex-mixed-profiles");

    expect(scenario.runtimePairLane).toBeUndefined();
    expect(scenario.runtimeParityUsage).toBeUndefined();
    expect(scenario.execution).toMatchObject({
      kind: "vitest",
      path: "test/e2e/qa-lab/runtime/codex-auth-product-proof.e2e.test.ts",
    });
    expect(scenario.coverage?.primary).toEqual([`${codex}.codex-oauth-profiles-codex-plugin-auth`]);
    expect(scenario.coverage?.secondary).toEqual([
      `${agentRuntime}.auth-profile-selection-provider-selection`,
      `${codex}.codex-oauth-profiles-doctor-repair`,
    ]);
  });

  it("keeps the character eval scenario natural and task-shaped", () => {
    const characterConfig = readQaScenarioExecutionConfig("character-vibes-gollum") as
      | {
          workspaceFiles?: Record<string, string>;
          turns?: Array<{ text?: string; expectFile?: { path?: string } }>;
        }
      | undefined;

    const turnTexts = characterConfig?.turns?.map((turn) => turn.text ?? "") ?? [];

    expect(characterConfig?.workspaceFiles?.["SOUL.md"]).toContain("# This is your character");
    expect(turnTexts.join("\n")).toContain("precious-status.html");
    expect(turnTexts.join("\n")).not.toContain("How would you react");
    expect(turnTexts.join("\n")).not.toContain("character check");
    expect(
      characterConfig?.turns?.some((turn) => turn.expectFile?.path === "precious-status.html"),
    ).toBe(true);
  });

  it("includes the codex leak scenario in the YAML pack", () => {
    const pack = readQaScenarioPack();
    const scenario = pack.scenarios.find(
      (candidate) => candidate.id === "codex-harness-no-meta-leak",
    );

    expect(scenario?.sourcePath).toBe("qa/scenarios/models/codex-harness-no-meta-leak.yaml");
    expect(scenario?.execution.flow?.steps.map((step) => step.name)).toContain(
      "keeps codex coordination chatter out of the visible reply",
    );
  });

  it("binds model switch follow-up assertions to the configured alternate model", () => {
    const scenario = requireFlowScenario(readQaScenarioById("model-switch-follow-up"));
    const flow = JSON.stringify(scenario.execution.flow);

    expect(flow).toContain("alternate?.model");
    expect(flow).toContain("config.followupPrompt");
    expect(flow).not.toContain("gpt-5.6-luna-alt");
  });

  it("keeps provider-sensitive QA flow scenarios on their supported lanes", () => {
    const strandedConfig = readQaScenarioExecutionConfig("message-tool-stranded-final-reply") as
      | { requiredProviderMode?: string }
      | undefined;
    const retryFailureConfig = readQaScenarioExecutionConfig(
      "message-tool-stranded-final-retry-failure",
    ) as { requiredProviderMode?: string } | undefined;
    const stranded = readQaScenarioById("message-tool-stranded-final-reply");
    const retryFailure = readQaScenarioById("message-tool-stranded-final-retry-failure");
    const heartbeat = readQaScenarioById("commitments-heartbeat-target-none");
    const heartbeatFlow = JSON.stringify(heartbeat.execution.flow);

    expect(strandedConfig?.requiredProviderMode).toBe("mock-openai");
    expect(retryFailureConfig?.requiredProviderMode).toBe("mock-openai");
    expect(JSON.stringify(stranded.execution.flow)).toContain(
      "this seeded scenario is mock-openai only",
    );
    expect(JSON.stringify(retryFailure.execution.flow)).toContain(
      "this seeded scenario is mock-openai only",
    );
    expect(heartbeatFlow).toContain("sessionKey");
    expect(heartbeatFlow).toContain("commitmentOutbound.length === 0");
    expect(heartbeatFlow).not.toContain("waitForNoOutbound");
  });

  it("includes the thinking slash model remap scenario", () => {
    const scenario = readQaScenarioById("thinking-slash-model-remap");
    const config = readQaScenarioExecutionConfig("thinking-slash-model-remap") as
      | {
          requiredProviderMode?: string;
          anthropicModelRef?: string;
          openAiXhighModelRef?: string;
          noXhighModelRef?: string;
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/models/thinking-slash-model-remap.yaml");
    expect(config?.requiredProviderMode).toBe("live-frontier");
    expect(config?.anthropicModelRef).toBe("anthropic/claude-sonnet-4-6");
    expect(config?.openAiXhighModelRef).toBe("openai/gpt-5.5");
    expect(config?.noXhighModelRef).toBe("anthropic/claude-sonnet-4-6");
    const flowText = JSON.stringify(scenario.execution.flow);
    expect(flowText).toContain("include max and omit xhigh");
    expect(flowText).not.toContain("omit xhigh/max");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "selects Anthropic and verifies adaptive options",
      "maps adaptive to medium when switching to OpenAI",
      "maps xhigh to high on a model without xhigh",
    ]);
  });

  it("keeps Anthropic thinking recovery on its resolved replay-safe mock route", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("anthropic-thinking-error-recovery-replay-safe-read"),
    );
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.execution.config).toMatchObject({
      requiredProviderMode: "mock-openai",
      anthropicModelRef: "anthropic/claude-opus-4-8",
    });
    expect(scenario.gatewayConfigPatch).toMatchObject({
      agents: { defaults: { models: { "anthropic/claude-opus-4-8": { params: {} } } } },
      tools: { codeMode: { enabled: false } },
    });
    expect(flow).toContain("modelAck.resolved?.modelProvider === 'anthropic'");
    expect(flow).toContain("modelAck.resolved?.model === 'claude-opus-4-8'");
    expect(flow).toContain('"set":"scenarioPrompt"');
    expect(flow).toContain("`${config.prompt} QA scenario run: ${sessionKey}`");
    expect(flow).toContain('"message":{"expr":"scenarioPrompt"}');
    expect(flow).toContain("effectiveToolIds.includes('read')");
    expect(flow).toContain('"call":"runAgentPrompt"');
    expect(flow).toContain('"provider":"anthropic"');
    expect(flow).toContain('"model":"claude-opus-4-8"');
    expect(flow).toContain("/debug/requests?after=${requestCursorBefore}");
    expect(flow).toContain("request.plannedToolName === 'read'");
    expect(flow).toContain(").length >= 3");
    expect(flow).toContain("!scenarioRequests.some((request)");
    expect(flow).toContain("config.visibleAnswerRetryNeedle");
    expect(flow).toContain('"sinceIndex":{"ref":"outboundStartIndex"}');
    const requestEvidenceIndex = flow.indexOf('"set":"scenarioRequests"');
    expect(requestEvidenceIndex).toBeGreaterThanOrEqual(0);
    expect(requestEvidenceIndex).toBeLessThan(flow.indexOf('"call":"waitForOutboundMessage"'));
  });

  it("includes the seeded mock-only broken-turn scenarios in the YAML pack", () => {
    const scenarioIds = [
      "reasoning-only-recovery-replay-safe-read",
      "reasoning-only-no-auto-retry-after-write",
      "empty-response-recovery-replay-safe-read",
      "empty-response-retry-budget-exhausted",
    ];

    for (const scenarioId of scenarioIds) {
      const scenario = readQaScenarioById(scenarioId);
      const config = readQaScenarioExecutionConfig(scenarioId) as
        | {
            requiredProvider?: string;
            prompt?: string;
          }
        | undefined;

      expect(scenario.sourcePath).toBe(`qa/scenarios/runtime/${scenarioId}.yaml`);
      expect(config?.requiredProvider).toBe("mock-openai");
      expect(config?.prompt).toContain("check");
      expect(scenario.execution.flow?.steps.length).toBeGreaterThan(0);
    }
  });

  it("keeps mock-only image debug assertions guarded in live-frontier runs", () => {
    const scenario = readQaScenarioPack().scenarios.find(
      (candidate) => candidate.id === "image-understanding-attachment",
    );
    const imageRequestAction = scenario?.execution.flow?.steps
      .flatMap((step) => step.actions ?? [])
      .find(
        (
          action,
        ): action is {
          set: string;
          value?: { expr?: string };
        } =>
          typeof action === "object" &&
          action !== null &&
          "set" in action &&
          action.set === "imageRequest",
      );
    const imageRequestExpr = imageRequestAction?.value?.expr;

    expect(imageRequestExpr).toContain("env.mock ?");
    expect(imageRequestExpr).toContain("/debug/requests");
  });

  it("adds a repo-instruction followthrough scenario to the parity pack", () => {
    const scenario = readQaScenarioById("instruction-followthrough-repo-contract");
    const config = readQaScenarioExecutionConfig("instruction-followthrough-repo-contract") as
      | {
          workspaceFiles?: Record<string, string>;
          prompt?: string;
          expectedReplyAll?: string[];
          expectedArtifactAll?: string[];
          expectedArtifactAny?: string[];
        }
      | undefined;

    expect(config?.workspaceFiles?.["AGENT.md"]).toContain("Step order:");
    expect(config?.workspaceFiles?.["SOUL.md"]).toContain("action-first");
    expect(config?.workspaceFiles?.["FOLLOWTHROUGH_INPUT.md"]).toContain(
      "Mission: prove you followed the repo contract.",
    );
    expect(config?.prompt).toContain("Repo contract followthrough check.");
    expect(scenario.execution.channel).toBe("qa-channel");
    expect(config?.expectedReplyAll).toEqual(["read:", "wrote:", "status:"]);
    expect(config?.expectedArtifactAll).toEqual(["repo contract"]);
    expect(config?.expectedArtifactAny).toContain("evidence path");
    expect(scenario.title).toBe("Instruction followthrough repo contract");
  });

  it("declares native QA-channel fixtures by channel", () => {
    const scenarioIds = [
      "instruction-followthrough-repo-contract",
      "subagent-forked-context",
      "subagent-handoff",
      "a2a-message-tool-mirror-dedupe",
      "group-message-tool-unavailable-fallback",
      "qa-channel-reconnect-dedupe",
      "reaction-edit-delete",
      "image-generation-roundtrip",
      "image-understanding-attachment",
      "native-image-generation",
      "goal-context-next-turn",
      "goal-context-survives-compaction",
      "goal-followthrough-live",
      "active-memory-preprompt-recall",
      "remember-across-conversations",
      "memory-recall",
      "session-memory-ranking",
      "thread-memory-isolation",
      "personal-channel-thread-reply",
      "personal-memory-preference-recall",
      "personal-reminder-roundtrip",
      "cron-condition-watcher",
      "cron-natural-fire-no-duplicate",
      "cron-one-minute-ping",
      "cron-single-run-no-duplicate",
      "control-ui-qa-channel-image-roundtrip",
      "control-ui-assistant-transcript-role-boundary",
      "config-apply-restart-wakeup",
    ];

    for (const scenarioId of scenarioIds) {
      expect(readQaScenarioById(scenarioId).execution.channel, scenarioId).toBe("qa-channel");
    }
  });

  it("keeps portable thread relation flows on channels with native thread semantics", () => {
    for (const scenarioId of ["thread-follow-up", "thread-isolation"]) {
      const scenario = requireFlowScenario(readQaScenarioById(scenarioId));

      expect(scenario.execution.channel, scenarioId).toBeUndefined();
      expect(scenario.execution.channels, scenarioId).toEqual(["qa-channel", "slack", "matrix"]);
    }
  });

  it("keeps Matrix subagent thread spawn explicitly selectable", () => {
    const scenario = readQaScenarioById("subagent-thread-spawn");

    expect(scenario.execution.channel).toBe("matrix");
  });

  it("keeps the Control UI transcript role boundary in the mock lane", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("control-ui-assistant-transcript-role-boundary"),
    );

    expect(scenario.execution.providerMode).toBe("mock-openai");
  });

  it("keeps remember-across-conversations isolated and product-only", () => {
    const scenario = requireFlowScenario(readQaScenarioById("remember-across-conversations"));
    const config = readQaScenarioExecutionConfig("remember-across-conversations") as
      | { requiredChannelDriver?: string }
      | undefined;
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.execution.suiteIsolation).toBe("isolated");
    expect(config?.requiredChannelDriver).toBe("qa-channel");
    expect(scenario.gatewayConfigPatch).toMatchObject({
      session: { dmScope: "per-channel-peer" },
      memory: { search: { rememberAcrossConversations: true } },
      plugins: {
        entries: {
          "active-memory": {
            enabled: true,
            config: { enabled: true, mode: "always", agents: [] },
          },
        },
      },
    });
    expect(flow).toContain("[sourceSessionKey, targetSessionKey, groupSessionKey]");
    expect(flow).toContain("readSessionTranscriptSummary");
    expect(flow).toContain("transcript.eventCursor > 0");
    expect(flow).toContain(
      "state.getSnapshot().messages.filter((message) => message.direction === 'outbound').length",
    );
    expect(flow).toContain('"saveAs":"pauseCommandOutbound"');
    expect(flow).toContain("candidate.conversation.id === config.pausedConversationId");
    expect(flow).toContain('"sinceIndex":{"ref":"pauseCommandStartIndex"}');
    expect(flow).not.toContain('"call":"sleep"');
    expect(flow).not.toContain(".sessionFile");
  });
});
