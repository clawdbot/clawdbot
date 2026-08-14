import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";
import { readFlowAssertExpression, requireFlowScenario } from "./scenario-catalog.test-utils.js";

describe("qa compaction scenario catalog", () => {
  it.each([
    {
      id: "compaction-empty-response-recovery",
      coverage: "session-memory.compaction-empty-response-recovery",
      faultMode: "empty-output-once",
      summaryMarker: "QA-COMPACTION-EMPTY-RECOVERED-SUMMARY",
    },
    {
      id: "compaction-reasoning-only-recovery",
      coverage: "session-memory.compaction-reasoning-only-recovery",
      faultMode: "reasoning-only-output-once",
      summaryMarker: "QA-COMPACTION-REASONING-RECOVERED-SUMMARY",
    },
  ])("keeps $id on the OpenClaw compaction owner", ({ id, coverage, faultMode, summaryMarker }) => {
    const scenario = requireFlowScenario(readQaScenarioById(id));
    const flow = JSON.stringify(scenario.execution.flow);
    const serializedScenario = JSON.stringify(scenario);

    expect(scenario.runtimePairLane).toBeUndefined();
    expect(scenario.coverage?.primary).toEqual([coverage]);
    expect(scenario.coverage?.secondary ?? []).toEqual([]);
    expect(scenario.gatewayConfigPatch).toMatchObject({
      agents: { defaults: { compaction: { mode: "default" } } },
    });
    expect(flow).toContain("env.runtimeId === 'openclaw'");
    expect(flow).toContain("initialRequests[0].errorCode === 'context_length_exceeded'");
    expect(flow).toContain("initialRequests.length === 2");
    expect(flow).toContain("compactionSummaryRequests.length === 2");
    expect(flow).toContain(
      `compactionSummaryRequests[0].compactionSummaryFaultMode === config.faultMode`,
    );
    expect(flow).toContain("compactionSummaryRequests[1].compactionSummaryFaultMode === 'none'");
    expect(flow).toContain(
      "compactionSummaryRequests[0].cursor < compactionSummaryRequests[1].cursor",
    );
    expect(flow).toContain(
      "scenarioRequests.every((request) => request.model === scenarioRequests[0].model)",
    );
    expect(flow).toContain("transcript.compactionSummaries.length === 1");
    expect(flow).toContain("transcript.compactionSummaries[0].includes(config.summaryMarker)");
    expect(flow).toContain("String(transcript.finalText ?? '').trim() === config.finalMarker");
    expect(flow).toContain("sessionEntry?.compactionCount === 1");
    expect(flow).toContain("request.requestKind === 'tool-continuation'");
    expect(flow).toContain("finalOutbound.length === 1");
    expect(serializedScenario).toContain(faultMode);
    expect(serializedScenario).toContain(summaryMarker);
    expect(serializedScenario).not.toContain("codex");
  });

  it("assigns compaction retry and pruning to OpenClaw with an early Codex gap", () => {
    const scenario = requireFlowScenario(readQaScenarioById("compaction-retry-mutating-tool"));
    const flow = JSON.stringify(scenario.execution.flow);
    const serializedScenario = JSON.stringify(scenario);
    const actions = scenario.execution.flow?.steps[0]?.actions ?? [];
    const readSetExpression = (name: string) => {
      const action = actions.find((candidate) => (candidate as { set?: string }).set === name) as
        | { value?: { expr?: string } }
        | undefined;
      return action?.value?.expr ?? "";
    };
    const readAssertExpression = (needle: string) =>
      actions.map(readFlowAssertExpression).find((expression) => expression.includes(needle)) ?? "";
    const actionIndex = (predicate: (action: (typeof actions)[number]) => boolean) =>
      actions.findIndex(predicate);
    const writeRequestsExpr = readSetExpression("writeRequests");
    const postWriteContinuationsExpr = readSetExpression("postWriteContinuations");
    const writeTranscriptToolCallIdExpr = readSetExpression("writeTranscriptToolCallId");
    const continuationChainExpr = readSetExpression("continuationChain");
    const compactionSummaryRequestsExpr = readSetExpression("compactionSummaryRequests");
    const overflowCheckpointsExpr = readSetExpression("overflowCheckpoints");
    const continuationAssertIndex = actionIndex((action) =>
      readFlowAssertExpression(action).includes("continuationChain.valid === true"),
    );
    const terminalAssertIndex = actionIndex((action) =>
      readFlowAssertExpression(action).includes("terminalContinuations.length === 1"),
    );
    const distinctCallIdsAssertIndex = actionIndex((action) =>
      readFlowAssertExpression(action).includes("new Set([writeRequest.plannedToolCallId"),
    );
    const stableCellIdAssertIndex = actionIndex((action) =>
      readFlowAssertExpression(action).includes("continuationChain.waits.length === 0"),
    );
    const terminalEvidenceAssertIndex = actionIndex((action) =>
      readFlowAssertExpression(action).includes(
        "terminalContinuations[0].providerVariant === 'openai'",
      ),
    );
    const outboundWaitIndex = actionIndex(
      (action) =>
        (action as { call?: string }).call === "waitForCondition" &&
        (action as { saveAs?: string }).saveAs === "outbound",
    );
    const stableCellIdAssertExpr = readAssertExpression("continuationChain.waits.length === 0");
    const terminalEvidenceAssertExpr = readAssertExpression(
      "terminalContinuations[0].providerVariant === 'openai'",
    );
    const compactionSummaryAssertExpr = readAssertExpression("compactionSummaryRequests.some");
    const noQualityRetryAssertExpr = readAssertExpression("Previous summary failed quality checks");
    const compactionSnapshotAssertExpr = readAssertExpression(
      "Number.isInteger(sessionEntry?.compactionCount)",
    );
    const overflowCheckpointAssertExpr = readAssertExpression("overflowCheckpoints.length === 1");
    const knownGap =
      "known-harness-gap compaction-retry-mutating-tool: provider-error recovery does not invoke Codex native compaction; native token-threshold compaction needs a separate scenario.";

    expect(scenario.runtimePairLane).toBe("core");
    expect(scenario.coverage?.primary).toEqual([
      "session-memory.compaction",
      "session-memory.compaction-retry-policy",
      "session-memory.pruning",
    ]);
    expect(scenario.coverage?.secondary ?? []).toEqual([]);
    expect(scenario.successCriteria).toContain(
      "One coded over-threshold provider overflow produces one persisted OpenClaw overflow compaction and one compacted retry retaining durable current context.",
    );
    expect(scenario.successCriteria).toContain(
      "OpenClaw performs exactly one successful write, then one terminal continuation after zero-or-more causally linked waits, and returns the exact file content and final marker.",
    );
    expect(scenario.successCriteria).toContain(
      "OpenClaw proves session-memory.pruning by retaining a nonempty contiguous suffix ending at block 15 while pruning marker block 10.",
    );
    expect(scenario.successCriteria).toContain(
      "The Codex runtime-pair cell reports a known harness gap before gateway, session, or provider work and makes no compaction coverage claim.",
    );
    expect(scenario.successCriteria.join("\n")).not.toContain("Both runtime cells");

    const firstAction = scenario.execution.flow?.steps[0]?.actions[0] as
      | Record<string, unknown>
      | undefined;
    expect(firstAction).toBeDefined();
    const conditional = firstAction?.if as Record<string, unknown> | undefined;
    expect(conditional?.expr).toBe("env.runtimeId === 'codex'");
    expect(conditional?.["then"]).toMatchObject([
      {
        call: "qaImport",
        args: ["./errors.js"],
        saveAs: "qaErrors",
      },
      {
        throw: {
          expr: expect.stringContaining(`QaSuiteScenarioSkipError('${knownGap}')`),
        },
      },
    ]);
    const runtimeGuard = scenario.execution.flow?.steps[0]?.actions[1] as
      | Record<string, unknown>
      | undefined;
    expect(runtimeGuard?.assert).toMatchObject({
      expr: expect.stringContaining("env.runtimeId === 'openclaw'"),
    });

    const knownGapIndex = flow.indexOf(knownGap);
    const gatewayWorkIndex = flow.indexOf('"call":"waitForGatewayHealthy"');
    expect(knownGapIndex).toBeGreaterThanOrEqual(0);
    expect(knownGapIndex).toBeLessThan(gatewayWorkIndex);
    expect(flow).toContain('"call":"qaImport","args":["./errors.js"],"saveAs":"qaErrors"');
    expect(flow).toContain("new qaErrors.QaSuiteScenarioSkipError");
    expect(flow).toContain("seedQaSessionTranscript");
    expect(flow).toContain("sessions.compaction.branch");
    expect(flow).toContain("env.runtimeId");
    expect(scenario.execution.retryCount).toBe(0);
    expect(flow).not.toContain('"transcriptToolName":"write"');
    expect(flow).not.toContain('"requireSuccessfulTranscriptToolResult":true');
    expect(serializedScenario).not.toContain("expectedWriteToolResult");
    expect(flow).toContain("outbound.text === config.finalMarker");
    expect(flow).toContain("overflowRequests.length === 1");
    expect(flow).toContain("overflowRequest.rawByteLength > config.overflowThresholdBytes");
    expect(flow).toContain("writeRequests.length === 1");
    expect(writeRequestsExpr).toContain("request.plannedToolName === 'write'");
    expect(writeRequestsExpr).toContain("request.cursor > overflowRequest.cursor");
    expect(writeRequestsExpr).toContain("String(request.allInputText ?? '').includes(sessionId)");
    expect(writeRequestsExpr).toContain(
      "String(request.allInputText ?? '').includes(config.promptSnippet)",
    );
    expect(writeRequestsExpr).toContain(
      "String(request.allInputText ?? '').includes(config.durableMarker)",
    );
    expect(writeRequestsExpr).not.toContain("request.requestKind");
    expect(writeRequestsExpr).not.toContain("request.outcome");
    expect(writeRequestsExpr).not.toContain("request.toolOutput");
    expect(writeRequestsExpr).not.toContain("request.plannedToolArgs");
    expect(writeRequestsExpr).not.toContain("request.plannedWireToolName");
    expect(flow).toContain("writeRequest.requestKind === 'agent-initial'");
    expect(flow).toContain("writeRequest.outcome === 'success'");
    expect(flow).toContain("!writeRequest.toolOutput");
    expect(flow).toContain(
      "String(writeRequest.allInputText ?? '').includes(config.durableMarker)",
    );
    expect(flow).not.toContain("request.plannedWireToolName === 'exec'");
    expect(flow).toContain(
      "writeRequest.plannedWireToolName === undefined || writeRequest.plannedWireToolName === 'exec'",
    );
    expect(flow).toContain("writeRequest.plannedToolArgs?.path === config.outputFile");
    expect(flow).toContain("writeRequest.plannedToolArgs?.content === config.expectedFileContent");
    expect(flow).toContain("typeof writeRequest.plannedToolCallId === 'string'");
    expect(flow).not.toContain(
      "writeRequest.plannedToolCallId.length > 0 && typeof writeRequest.plannedToolItemId",
    );
    expect(flow).toContain(
      'writeWireToolName","value":{"expr":"writeRequest.plannedWireToolName ?? writeRequest.plannedToolName',
    );
    expect(writeTranscriptToolCallIdExpr).toContain(
      "typeof writeRequest.plannedToolItemId === 'string'",
    );
    expect(writeTranscriptToolCallIdExpr).toContain("writeRequest.plannedToolItemId.length > 0");
    expect(writeTranscriptToolCallIdExpr).toContain(
      "`${writeRequest.plannedToolCallId}|${writeRequest.plannedToolItemId}`",
    );
    expect(writeTranscriptToolCallIdExpr).toContain(": writeRequest.plannedToolCallId");
    expect(flow).toContain(
      "event.toolCallId === writeTranscriptToolCallId && event.name === writeWireToolName",
    );
    expect(flow).toContain("successfulWriteTranscriptEvents.length === 1");
    expect(flow).toContain("transcript.successfulToolCallCounts[writeWireToolName] === 1");
    expect(flow).not.toContain("transcript.successfulToolCallCounts.write === 1");
    expect(postWriteContinuationsExpr).toContain("request.requestKind === 'tool-continuation'");
    expect(postWriteContinuationsExpr).toContain("request.cursor > writeRequest.cursor");
    expect(postWriteContinuationsExpr).toContain(
      "String(request.allInputText ?? '').includes(sessionId)",
    );
    expect(postWriteContinuationsExpr).not.toContain("request.outcome");
    expect(postWriteContinuationsExpr).not.toContain("request.plannedToolName");
    expect(postWriteContinuationsExpr).not.toContain("request.toolOutputCallId");
    expect(postWriteContinuationsExpr).not.toContain("request.toolOutputStructuredError");
    expect(flow).toContain("let currentCallId = writeRequest.plannedToolCallId");
    expect(flow).toContain("postWriteContinuations.filter");
    expect(flow).toContain("request.toolOutputCallId === currentCallId");
    expect(flow).toContain("request.plannedToolName === 'wait'");
    expect(flow).toContain("currentCallId = request.plannedToolCallId");
    expect(continuationChainExpr).toContain("request.toolOutputCallId === currentCallId");
    expect(continuationChainExpr).toContain("request.plannedToolName === 'wait'");
    expect(flow).toContain("continuationChain.requests.length === postWriteContinuations.length");
    expect(flow).toContain(
      "continuationChain.requests.every((request, index) => request === postWriteContinuations[index])",
    );
    expect(flow).toContain(
      "continuationChain.requests.length === continuationChain.waits.length + 1",
    );
    expect(flow).toContain("request.outcome === 'success'");
    expect(flow).toContain("request.toolOutputStructuredError !== true");
    expect(flow).toContain("terminalContinuations.length === 1");
    expect(flow).toContain("terminalContinuations[0] === continuationChain.terminal");
    expect(flow).toContain("String(terminalContinuations[0].toolOutput ?? '').trim().length > 0");
    expect(flow).toContain("new Set([writeRequest.plannedToolCallId");
    expect(stableCellIdAssertExpr).toContain("continuationChain.waits.length === 0 ||");
    expect(stableCellIdAssertExpr).toContain(
      "typeof request.plannedToolArgs?.cell_id === 'string'",
    );
    expect(stableCellIdAssertExpr).toContain(
      "new Set(continuationChain.waits.map((request) => request.plannedToolArgs.cell_id)).size === 1",
    );
    expect(terminalEvidenceAssertExpr).toContain("writeWireToolName !== 'exec'");
    const openAiEvidenceIndex = terminalEvidenceAssertExpr.indexOf(
      "terminalContinuations[0].providerVariant === 'openai'",
    );
    const anthropicEvidenceIndex = terminalEvidenceAssertExpr.indexOf(
      "terminalContinuations[0].providerVariant === 'anthropic'",
    );
    const unknownProviderFailClosedIndex = terminalEvidenceAssertExpr.lastIndexOf(": false");
    expect(openAiEvidenceIndex).toBeGreaterThanOrEqual(0);
    expect(terminalEvidenceAssertExpr).toContain("startsWith('Script completed\\n')");
    expect(anthropicEvidenceIndex).toBeGreaterThan(openAiEvidenceIndex);
    expect(terminalEvidenceAssertExpr).toContain(
      "JSON.parse(String(terminalContinuations[0].toolOutput ?? ''))",
    );
    expect(terminalEvidenceAssertExpr).toContain("parsed !== null");
    expect(terminalEvidenceAssertExpr).toContain("typeof parsed === 'object'");
    expect(terminalEvidenceAssertExpr).toContain("!Array.isArray(parsed)");
    expect(terminalEvidenceAssertExpr).toContain("parsed.status === 'completed'");
    expect(unknownProviderFailClosedIndex).toBeGreaterThan(anthropicEvidenceIndex);
    expect(continuationAssertIndex).toBeGreaterThanOrEqual(0);
    expect(terminalAssertIndex).toBeGreaterThan(continuationAssertIndex);
    expect(distinctCallIdsAssertIndex).toBeGreaterThan(terminalAssertIndex);
    expect(stableCellIdAssertIndex).toBeGreaterThan(distinctCallIdsAssertIndex);
    expect(terminalEvidenceAssertIndex).toBeGreaterThan(stableCellIdAssertIndex);
    expect(outboundWaitIndex).toBeGreaterThan(terminalEvidenceAssertIndex);
    expect(flow).not.toContain("config.expectedOpenClawToolResult");
    expect(flow).not.toContain("String(request.toolOutput ?? '').includes(`---");
    expect(flow).not.toContain("String(request.toolOutput ?? '').includes(`+++");
    expect(compactionSummaryRequestsExpr).toContain("request.requestKind === 'compaction-summary'");
    expect(compactionSummaryAssertExpr).toContain(
      "compactionSummaryRequests.some((request) => request.cursor > overflowRequest.cursor && request.cursor < writeRequest.cursor)",
    );
    expect(compactionSummaryAssertExpr).toContain(
      "compactionSummaryRequests.every((request) => request.outcome === 'success' && request.plannedToolName === undefined && request.toolOutputStructuredError !== true)",
    );
    expect(noQualityRetryAssertExpr).toContain("compactionSummaryRequests.every");
    expect(noQualityRetryAssertExpr).toContain(
      "!String(request.allInputText ?? '').includes('Previous summary failed quality checks')",
    );
    expect(compactionSnapshotAssertExpr).toContain(
      "Number.isInteger(sessionEntry?.compactionCount) && sessionEntry.compactionCount >= 1",
    );
    expect(compactionSnapshotAssertExpr).toContain(
      "Number.isFinite(sessionEntry?.totalTokens) && sessionEntry?.totalTokensFresh === true",
    );
    expect(compactionSnapshotAssertExpr).not.toContain("compactionCount === 1");
    expect(flow).not.toContain("sessionEntry?.compactionCount === 1");
    expect(overflowCheckpointsExpr).toContain("checkpoint.reason === 'overflow-retry'");
    expect(overflowCheckpointAssertExpr).toContain("overflowCheckpoints.length === 1");
    expect(flow).not.toContain("compactionSummaryRequests.length === 1");
    expect(flow).toContain(
      "writeRequest.rawByteLength < config.overflowThresholdBytes && writeRequest.rawByteLength < overflowRequest.rawByteLength",
    );
    expect(flow).not.toContain("initialRequests.length === 2");
    expect(flow).toContain("index === 10 ? config.bulkyMarker + ' ' : ''");
    expect(flow).toContain("post-marker historical user block");
    expect(flow).not.toContain("index === 12 ? config.bulkyMarker + ' ' : ''");
    expect(flow).toContain("{ role: 'assistant', text: config.checkpointMarker");
    expect(flow).not.toContain("{ role: 'assistant', text: config.bulkyMarker");
    expect(flow).toContain("branchSummary.finalText === config.checkpointMarker");
    expect(flow).toContain('"set":"requestEvidence"');
    expect(flow).toContain("durable: String(request.allInputText ?? '')");
    expect(flow).toContain("bulky: String(request.allInputText ?? '')");
    expect(flow).toContain("qualityRetry: String(request.allInputText ?? '')");
    expect(flow).toContain("inputChars: String(request.allInputText ?? '').length");
    expect(flow).toContain(
      "resolvedWireTool: request.plannedWireToolName ?? request.plannedToolName ?? null",
    );
    expect(flow).toContain("callId: request.plannedToolCallId ?? null");
    expect(flow).toContain("itemId: request.plannedToolItemId ?? null");
    expect(flow).toContain(
      "transcriptId: typeof request.plannedToolItemId === 'string' && request.plannedToolItemId.length > 0",
    );
    expect(flow).toContain(": request.plannedToolCallId ?? null");
    expect(flow).toContain("logicalWrites=${String(writeRequests.length)}");
    expect(flow).toContain("wireTool=${String(writeWireToolName)}");
    expect(flow).toContain("callId=${String(writeRequest.plannedToolCallId)}");
    expect(flow).toContain("itemId=${String(writeRequest.plannedToolItemId)}");
    expect(flow).toContain("transcriptId=${String(writeTranscriptToolCallId)}");
    expect(flow).toContain(
      "wireSuccesses=${String(transcript.successfulToolCallCounts[writeWireToolName] ?? 0)}",
    );
    expect(flow).not.toContain("clientSessionId");
    expect(flow).toContain("tailBlocks:");
    expect(flow).toContain(".sort().slice(0, 16)");
    expect(flow).toContain('"set":"overflowEvidence"');
    expect(flow).toContain('"set":"writeEvidence"');
    expect(flow).toContain(
      "String(overflowRequest.allInputText ?? '').includes(config.bulkyMarker)",
    );
    expect(flow).toContain("!String(writeRequest.allInputText ?? '').includes(config.bulkyMarker)");
    expect(flow).toContain("JSON.stringify(overflowEvidence.tailBlocks)");
    expect(flow).toContain("writeEvidence.tailBlocks.length > 0");
    expect(flow).toContain("!writeEvidence.tailBlocks.includes('10')");
    expect(flow).toContain("16 - writeEvidence.tailBlocks.length + index");
    expect(serializedScenario).not.toContain("remote-compaction");
    expect(serializedScenario).not.toContain("remoteCompaction");
    expect(flow).not.toContain("JSON.stringify(overflowRequest)");
    const requestEvidenceIndex = flow.indexOf('"set":"scenarioRequests"');
    expect(requestEvidenceIndex).toBeGreaterThanOrEqual(0);
    expect(requestEvidenceIndex).toBeLessThan(flow.indexOf('"call":"fs.readFile"'));
  });
});
