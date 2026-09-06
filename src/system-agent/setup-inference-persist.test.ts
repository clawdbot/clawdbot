import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assertAgentHarnessRunAdmission,
  claimAgentSessionWriter,
} from "../agents/embedded-agent-runner/run/session-bootstrap.js";
import { resolveAgentRunSessionTarget } from "../agents/run-session-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { ActivateSetupInferenceDeps } from "./setup-inference-core.js";
import { completeSetupInferenceConfig } from "./setup-inference-verify.js";

const tempRoots = createTempDirTracker();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  tempRoots.cleanup();
});

describe("setup completion session ownership", () => {
  it.each([undefined, "openclaw"] as const)(
    "keeps a named owner's completion out of durable sessions (runtime: %s)",
    async (harness) => {
      const root = tempRoots.make("openclaw-setup-completion-");
      const stateDir = path.join(root, "state");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { research: {} },
          defaults: {
            model: { primary: "openai/gpt-5.6-luna" },
            ...(harness
              ? { models: { "openai/gpt-5.6-luna": { agentRuntime: { id: harness } } } }
              : {}),
          },
        },
      };
      const before = structuredClone(config);
      const runEmbeddedAgent = vi.fn<NonNullable<ActivateSetupInferenceDeps["runEmbeddedAgent"]>>(
        async (params) => {
          expect(params.agentId).toBe("research");
          expect(params.agentHarnessRuntimeOverride).toBe(harness);
          expect(params.prompt).toBe("Suggest a short project name.");
          // Follow the runner's admission -> target -> writer order with real accessors.
          assertAgentHarnessRunAdmission(params);
          const sessionTarget = await resolveAgentRunSessionTarget({
            ...params,
            missingSessionKey: "create",
          });
          await claimAgentSessionWriter({ ...params, sessionTarget });
          return {
            payloads: [{ text: "Small Harbor" }],
            meta: {
              durationMs: 1,
              executionTrace: { winnerProvider: params.provider, winnerModel: params.model },
            },
          };
        },
      );

      const result = await completeSetupInferenceConfig({
        config,
        prompt: "Suggest a short project name.",
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        deps: { runEmbeddedAgent },
      });
      await expect(
        fs.access(path.join(stateDir, "agents", "research", "agent", "openclaw-agent.sqlite")),
      ).rejects.toThrow();
      expect(result).toMatchObject({
        ok: true,
        text: "Small Harbor",
        modelRef: "openai/gpt-5.6-luna",
      });
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      expect(config).toEqual(before);
    },
  );
});
