import { describe, expect, it } from "vitest";
import { shouldTreatEmptyAssistantReplyAsSilent } from "./incomplete-turn-recovery.js";
import { resolveIncompleteTurnPayloadText } from "./incomplete-turn-resolution.js";
import { resolveRuntimeContextPromptParts } from "./runtime-context-prompt.js";
import {
  extractRuntimeResumeContract,
  isBlockedRuntimeResumeSilentReply,
  RUNTIME_RESUME_SILENT_REPLY_BLOCKED_TEXT,
  shouldBlockSilentReplyOnRuntimeResume,
} from "./runtime-resume-contract.js";

const INCIDENT_RUNTIME_CONTEXT = [
  "Compaction interrupted an approved artifact build.",
  "Session: agent:k3rnel:discord:channel:1540412387503509635",
  "User approved with: Do it.",
  "CLCR: open",
  "Outline approved, packet not started.",
  "Next turn must build the PDF and Excel deliverables.",
  "Memory checkpoint is not completion.",
].join("\n");

describe("runtime resume contract", () => {
  it("opens a resume contract from the false-closure incident markers", () => {
    const contract = extractRuntimeResumeContract(INCIDENT_RUNTIME_CONTEXT);
    expect(contract.open).toBe(true);
    expect(contract.signals).toEqual(
      expect.arrayContaining(["clcr-open", "packet-not-started", "next-turn-must-build"]),
    );
    expect(contract.deliverables.join(" ").toLowerCase()).toMatch(/pdf|excel/);
    expect(contract.completionGate).toMatch(/deliverable|blocker/i);
  });

  it("stays closed for ordinary runtime events with no pending user task", () => {
    const contract = extractRuntimeResumeContract(
      "Heartbeat poll. No pending user task. Status only.",
    );
    expect(contract.open).toBe(false);
    expect(
      shouldBlockSilentReplyOnRuntimeResume({ runtimeOnly: true, resumeContract: contract }),
    ).toBe(false);
  });

  it("injects continuation directive + structured contract into runtime-only system context", () => {
    const parts = resolveRuntimeContextPromptParts({
      effectivePrompt: INCIDENT_RUNTIME_CONTEXT,
      transcriptPrompt: "",
    });
    expect(parts.runtimeOnly).toBe(true);
    expect(parts.prompt).toBe("Continue the OpenClaw runtime event.");
    expect(parts.resumeContract?.open).toBe(true);
    expect(parts.runtimeSystemContext).toContain("Runtime resume directive:");
    expect(parts.runtimeSystemContext).toContain('"open": true');
    expect(parts.runtimeSystemContext).toContain("Structured resume contract");
  });

  it("does not mark ordinary runtime events with an open resume contract", () => {
    const parts = resolveRuntimeContextPromptParts({
      effectivePrompt: "internal housekeeping event",
      transcriptPrompt: "",
    });
    expect(parts.runtimeOnly).toBe(true);
    expect(parts.resumeContract).toBeUndefined();
    expect(parts.runtimeSystemContext).not.toContain("Runtime resume directive:");
  });

  it("blocks exact NO_REPLY while a runtime resume contract is open", () => {
    const contract = extractRuntimeResumeContract(INCIDENT_RUNTIME_CONTEXT);
    expect(
      isBlockedRuntimeResumeSilentReply({
        runtimeOnly: true,
        resumeContract: contract,
        assistantTexts: ["NO_REPLY"],
      }),
    ).toBe(true);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: {
          assistantTexts: ["NO_REPLY"],
          replayMetadata: { hadPotentialSideEffects: false },
          blockRuntimeResumeSilentReply: true,
        } as never,
      }),
    ).toBe(false);
    expect(
      resolveIncompleteTurnPayloadText({
        payloadCount: 0,
        aborted: false,
        externalAbort: false,
        timedOut: false,
        attempt: {
          assistantTexts: ["NO_REPLY"],
          replayMetadata: { hadPotentialSideEffects: false },
          blockRuntimeResumeSilentReply: true,
        } as never,
      }),
    ).toBe(RUNTIME_RESUME_SILENT_REPLY_BLOCKED_TEXT);
  });

  it("still allows intentional NO_REPLY when no resume contract is open", () => {
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: {
          assistantTexts: ["NO_REPLY"],
          replayMetadata: { hadPotentialSideEffects: false },
        } as never,
      }),
    ).toBe(true);
    expect(
      resolveIncompleteTurnPayloadText({
        payloadCount: 0,
        aborted: false,
        externalAbort: false,
        timedOut: false,
        attempt: {
          assistantTexts: ["NO_REPLY"],
          replayMetadata: { hadPotentialSideEffects: false },
        } as never,
      }),
    ).toBeNull();
  });
});

/**
 * Canary transcript shape for the 2026-08-24 false-closure incident.
 * Not a live gateway session — proves the contract machine for CI/canary review.
 */
describe("runtime false-closure canary transcript", () => {
  it("keeps the task active across compaction → memory checkpoint → NO_REPLY attempt", () => {
    const finalAssistant = {
      role: "assistant" as const,
      text: "NO_REPLY",
    };
    const transcript = [
      {
        role: "user" as const,
        text: "Build the approved PDF and Excel packet. Do it.",
      },
      {
        role: "assistant" as const,
        text: "Starting the packet…",
      },
      {
        role: "runtime" as const,
        kind: "compaction",
        syntheticPrompt: "Continue the OpenClaw runtime event.",
        context: INCIDENT_RUNTIME_CONTEXT,
      },
      {
        role: "assistant" as const,
        tool: "memory_append",
        result: "ok",
        note: "checkpoint only — packet not started",
      },
      finalAssistant,
    ];

    const resumeTurn = transcript.find((entry) => entry.role === "runtime");
    expect(resumeTurn).toBeTruthy();
    const parts = resolveRuntimeContextPromptParts({
      effectivePrompt: INCIDENT_RUNTIME_CONTEXT,
      transcriptPrompt: "",
    });
    expect(parts.runtimeOnly).toBe(true);
    expect(parts.resumeContract?.open).toBe(true);

    expect(finalAssistant.text).toBe("NO_REPLY");
    expect(
      isBlockedRuntimeResumeSilentReply({
        runtimeOnly: true,
        resumeContract: parts.resumeContract,
        assistantTexts: [finalAssistant.text],
      }),
    ).toBe(true);

    const blockedText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      externalAbort: false,
      timedOut: false,
      attempt: {
        assistantTexts: ["NO_REPLY"],
        replayMetadata: { hadPotentialSideEffects: true },
        blockRuntimeResumeSilentReply: true,
      } as never,
    });
    expect(blockedText).toBe(RUNTIME_RESUME_SILENT_REPLY_BLOCKED_TEXT);
    // Task remains active: silent path is rejected and a visible continuation is required.
    expect(blockedText).not.toBeNull();
    expect(parts.runtimeSystemContext).toContain("Checkpoint-only work");
  });
});
