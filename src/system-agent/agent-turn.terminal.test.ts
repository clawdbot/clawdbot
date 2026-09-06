import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.js";
import { createSystemAgentSession } from "./agent-turn.js";
import { runSystemAgentTurnWithDeps } from "./agent-turn.test-support.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import {
  createSystemAgentVerifiedInferenceTestFixture,
  installSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let pluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot | undefined;

beforeAll(() => {
  pluginMetadataSnapshot = installSystemAgentPluginMetadataTestSnapshot();
});

afterAll(() => pluginMetadataSnapshot?.restore());

afterEach(() => {
  vi.unstubAllEnvs();
  pluginMetadataSnapshot?.rebindForCurrentEnv();
});

describe("system-agent terminal failure cleanup", () => {
  it.each([
    {
      name: "runner rejection",
      runEmbeddedAgent: async () => {
        throw new Error("provider unavailable");
      },
    },
    {
      name: "empty model output",
      runEmbeddedAgent: async () => ({ payloads: [] }),
    },
    {
      name: "hidden reasoning",
      runEmbeddedAgent: async () => ({
        payloads: [{ text: "Considering the answer", isReasoning: true }],
      }),
    },
    {
      name: "hidden commentary",
      runEmbeddedAgent: async () => ({
        payloads: [{ text: "Checking the gateway", isCommentary: true }],
      }),
    },
    {
      name: "explicitly hidden output",
      runEmbeddedAgent: async () => ({
        payloads: [{ text: "Private model output", visible: false }],
      }),
    },
    {
      name: "status notice",
      runEmbeddedAgent: async () => ({
        payloads: [{ text: "Still working", isStatusNotice: true }],
      }),
    },
    {
      name: "silent reply",
      runEmbeddedAgent: async () => ({ payloads: [{ text: "NO_REPLY" }] }),
    },
    {
      name: "raw-only hidden metadata",
      runEmbeddedAgent: async () => ({ meta: { finalAssistantRawText: "Hidden draft" } }),
    },
    {
      name: "timed-out turn with retained visible text",
      runEmbeddedAgent: async () => ({
        payloads: [{ text: "The setup turn timed out.", isError: true }],
        meta: {
          finalAssistantVisibleText: "I'll begin by checking the available models.",
          error: { kind: "incomplete_turn", message: "The setup turn timed out." },
        },
      }),
    },
    {
      name: "failed turn with partial payload text",
      runEmbeddedAgent: async () => ({
        payloads: [{ text: "I'll check the gateway." }],
        meta: { error: { kind: "incomplete_turn", message: "The provider failed." } },
      }),
    },
    {
      name: "blocked turn with partial payload text",
      runEmbeddedAgent: async () => ({
        payloads: [{ text: "I'll check the gateway." }],
        meta: { livenessState: "blocked" },
      }),
    },
    {
      name: "abandoned turn with retained visible text",
      runEmbeddedAgent: async () => ({
        meta: {
          finalAssistantVisibleText: "I'll check the gateway.",
          livenessState: "abandoned",
        },
      }),
    },
  ])("clears partial session state after $name", async ({ runEmbeddedAgent }) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-turn-failure-"));
    pluginMetadataSnapshot?.rebindForCurrentEnv();
    const config: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    };
    const { binding, deps } = await createSystemAgentVerifiedInferenceTestFixture(config);
    const session = createSystemAgentSession(binding);
    session.proposalRef.current = "partial-proposal";
    session.proposalRef.operation = { kind: "setup" };
    session.cliSession = {
      routeKey: "stale-route",
      binding: { sessionId: "uncertain-cli-session" },
    };

    await expect(
      runSystemAgentTurnWithDeps(
        {
          input: "hello",
          overview: { defaultModel: "openai/gpt-5.5" } as never,
          surface: "gateway",
          approvalArmed: false,
          session,
        },
        {
          ...deps,
          runEmbeddedAgent: runEmbeddedAgent as never,
          readConfigFileSnapshot: vi.fn(async () => ({
            exists: true,
            valid: true,
            path: "/tmp/openclaw.json",
            hash: "hash",
            config,
            runtimeConfig: config,
            sourceConfig: config,
            issues: [],
          })) as never,
        },
      ),
    ).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);
    expect(session.proposalRef.current).toBeUndefined();
    expect(session.proposalRef.operation).toBeUndefined();
    expect(session.cliSession).toBeUndefined();
  });
});
