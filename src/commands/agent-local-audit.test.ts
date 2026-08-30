import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { recordAdmittedModelRoutingDecision } from "../agents/model-routing-decision.js";
import { recordRuntimeActionDecision } from "../audit/runtime-action-decision.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentExecCommand } from "./agent-exec.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("agent local audit writer", () => {
  it("persists runtime receipts for an opted-in direct CLI run and clears its sink", async () => {
    const root = tempDirs.make("openclaw-agent-exec-audit-");
    const admittedAt = Date.now();
    let modelAdmission: PreparedAgentRunAdmission | undefined;
    let admittedRunContext: AdmittedRunContext | undefined;
    const requireToken = () => {
      const token = admittedRunContext?.executionIdentityToken;
      if (!token) {
        throw new Error("expected direct-local execution identity token");
      }
      return token;
    };
    const recordRuntimeReceipt = () => {
      const token = requireToken();
      return recordRuntimeActionDecision({
        token,
        family: "plugin",
        operation: "runtime",
        outcome: "allowed",
        coverageState: "attribution-only",
        reasonCode: "agent_exec_runtime_recorded",
        owner: "plugin-runtime",
        decisionBoundary: "agent-command.local",
        summary: "The direct local run recorded a bounded runtime action.",
        remediation: [],
        occurredAt: admittedAt + 1,
      });
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    setRuntimeConfigSnapshot({ logging: { audit: { executionIdentity: true } } });
    try {
      const result = await agentExecCommand("inspect", { stateDir: root }, runtime, {
        runAgent: vi.fn(async () => {
          modelAdmission = prepareAgentRunAdmission({
            cfg: { logging: { audit: { executionIdentity: true } } },
            operationalRunInstance: createOperationalRunInstanceRef("agent-exec-run"),
            facts: {
              runId: "agent-exec-run",
              agentId: "main",
              ingress: {
                kind: "local-cli",
                boundary: "agent-command.local",
                state: "present",
              },
            },
          });
          admittedRunContext = await modelAdmission.admit("embedded", "agent-exec-runtime");
          expect(
            recordAdmittedModelRoutingDecision({
              admittedRunContext,
              requestedProvider: "openai",
              requestedModel: "gpt-5.6",
              selectedProvider: "openai",
              selectedModel: "gpt-5.6-sol",
              selectionMode: "automatic",
              credentialProfileId: "openai:direct-local-profile",
              occurredAt: admittedAt + 1,
            }),
          ).toBe(true);
          expect(recordRuntimeReceipt()).toBe(true);
          return {
            payloads: [{ text: "done" }],
            meta: {
              durationMs: 1,
              agentMeta: {
                sessionId: "session-result",
                provider: "openai",
                model: "gpt-5.6-sol",
              },
            },
          };
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(recordRuntimeReceipt()).toBe(false);
      expect(
        recordAdmittedModelRoutingDecision({
          admittedRunContext,
          requestedProvider: "openai",
          requestedModel: "gpt-5.6",
          selectedProvider: "openai",
          selectedModel: "gpt-5.6-sol",
          selectionMode: "automatic",
        }),
      ).toBe(false);
      const token = requireToken();
      const database = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"), {
        readOnly: true,
      });
      try {
        const context = database
          .prepare("SELECT context_json FROM execution_identity_contexts WHERE execution_id = ?")
          .get(token.executionId) as { context_json: string };
        expect(JSON.parse(context.context_json)).toMatchObject({
          contextId: token.contextId,
          executionId: token.executionId,
          runId: token.runId,
          ingress: { kind: "local-cli", state: "present" },
        });
        const receipt = database
          .prepare(
            "SELECT receipt_json FROM execution_decision_facts WHERE execution_id = ? AND action_family = 'plugin'",
          )
          .get(token.executionId) as { receipt_json: string };
        expect(JSON.parse(receipt.receipt_json)).toMatchObject({
          contextId: token.contextId,
          executionId: token.executionId,
          runId: token.runId,
          action: { family: "plugin", operation: "runtime" },
          decision: { outcome: "allowed", reasonCode: "agent_exec_runtime_recorded" },
        });
        const modelReceipt = database
          .prepare(
            "SELECT receipt_json FROM execution_decision_facts WHERE execution_id = ? AND action_family = 'model-routing'",
          )
          .get(token.executionId) as { receipt_json: string };
        expect(JSON.parse(modelReceipt.receipt_json)).toMatchObject({
          action: {
            family: "model-routing",
            operation: "automatic-selection",
            resourceRef: expect.stringMatching(/^hmac-sha256:v1:/u),
            targetRef: expect.stringMatching(/^hmac-sha256:v1:/u),
          },
        });
        expect(modelReceipt.receipt_json).not.toContain("openai:direct-local-profile");
      } finally {
        database.close();
      }
    } finally {
      modelAdmission?.close();
      clearRuntimeConfigSnapshot();
    }
  });
});
