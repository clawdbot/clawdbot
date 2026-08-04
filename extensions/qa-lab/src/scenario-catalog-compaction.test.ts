import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";
import { requireFlowScenario } from "./scenario-catalog.test-utils.js";

describe("qa compaction scenario catalog", () => {
  it("assigns compaction retry and pruning to OpenClaw with an early Codex gap", () => {
    const scenario = requireFlowScenario(readQaScenarioById("compaction-retry-mutating-tool"));
    const flow = JSON.stringify(scenario.execution.flow);
    const serializedScenario = JSON.stringify(scenario);
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
      "OpenClaw performs exactly one successful write, one causal continuation, and returns the exact file content and final marker.",
    );
    expect(scenario.successCriteria).toContain(
      "OpenClaw proves session-memory.pruning by retaining tail blocks 11..15 while pruning marker block 10.",
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
    expect(conditional?.expr).toBe("env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME === 'codex'");
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

    const knownGapIndex = flow.indexOf(knownGap);
    const gatewayWorkIndex = flow.indexOf('"call":"waitForGatewayHealthy"');
    expect(knownGapIndex).toBeGreaterThanOrEqual(0);
    expect(knownGapIndex).toBeLessThan(gatewayWorkIndex);
    expect(flow).toContain('"call":"qaImport","args":["./errors.js"],"saveAs":"qaErrors"');
    expect(flow).toContain("new qaErrors.QaSuiteScenarioSkipError");
    expect(flow).toContain("seedQaSessionTranscript");
    expect(flow).toContain("sessions.compaction.branch");
    expect(flow).toContain("OPENCLAW_QA_FORCE_RUNTIME");
    expect(flow).toContain('"transcriptToolName":"write"');
    expect(flow).toContain('"requireSuccessfulTranscriptToolResult":true');
    expect(flow).toContain("outbound.text === config.finalMarker");
    expect(flow).toContain("overflowRequests.length === 1");
    expect(flow).toContain("overflowRequest.rawByteLength > config.overflowThresholdBytes");
    expect(flow).toContain("writeRequests.length === 1");
    expect(flow).toContain("String(request.allInputText ?? '').includes(sessionId)");
    expect(flow).toContain(
      "String(writeRequest.allInputText ?? '').includes(config.durableMarker)",
    );
    expect(flow).toContain("request.cursor > overflowRequest.cursor");
    expect(flow).toContain("request.plannedToolArgs?.path === config.outputFile");
    expect(flow).toContain("request.plannedToolArgs?.content === config.expectedFileContent");
    expect(flow).toContain("request.toolOutputCallId === writeRequest.plannedToolCallId");
    expect(flow).toContain("request.cursor > writeRequest.cursor");
    expect(flow).toContain(
      "String(request.toolOutput ?? '').trim() === config.expectedWriteToolResult",
    );
    expect(flow).not.toContain("config.expectedOpenClawToolResult");
    expect(flow).not.toContain("String(request.toolOutput ?? '').includes(`---");
    expect(flow).not.toContain("String(request.toolOutput ?? '').includes(`+++");
    expect(flow).toContain("postWriteContinuations.length === 1");
    expect(flow).toContain(
      "compactionSummaryRequests.every((request) => request.outcome === 'success' && request.plannedToolName === undefined)",
    );
    expect(flow).not.toContain("compactionSummaryRequests.length >= 1");
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
    expect(flow).toContain("inputChars: String(request.allInputText ?? '').length");
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
    expect(flow).toContain("JSON.stringify(['11', '12', '13', '14', '15'])");
    expect(serializedScenario).not.toContain("remote-compaction");
    expect(serializedScenario).not.toContain("remoteCompaction");
    expect(flow).not.toContain("JSON.stringify(overflowRequest)");
    const requestEvidenceIndex = flow.indexOf('"set":"scenarioRequests"');
    expect(requestEvidenceIndex).toBeGreaterThanOrEqual(0);
    expect(requestEvidenceIndex).toBeLessThan(flow.indexOf('"call":"fs.readFile"'));
  });
});
