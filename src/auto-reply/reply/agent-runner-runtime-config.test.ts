import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildEmbeddedRunBaseParams } from "./agent-runner-run-params.js";
import type { FollowupRun } from "./queue.js";

function makeRun(config: OpenClawConfig): FollowupRun["run"] {
  return {
    sessionId: "session-1",
    agentId: "agent-1",
    config,
    provider: "openai",
    model: "gpt-4.1",
    agentDir: "/tmp/agent",
    sessionKey: "agent:test:session",
    sessionFile: "/tmp/session.json",
    workspaceDir: "/tmp/workspace",
    skillsSnapshot: [],
    ownerNumbers: ["+15550001"],
    enforceFinalTag: false,
    skipProviderRuntimeHints: true,
    thinkLevel: "medium",
    verboseLevel: "off",
    reasoningLevel: "none",
    execOverrides: {},
    bashElevated: false,
    timeoutMs: 60_000,
  } as unknown as FollowupRun["run"];
}

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("buildEmbeddedRunBaseParams runtime config", () => {
  it("keeps an already-resolved run config instead of reverting to a stale runtime snapshot", () => {
    const staleSnapshot: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: {
              source: "env",
              provider: "default",
              id: "OPENAI_API_KEY",
            },
            models: [],
          },
        },
      },
    };
    const resolvedRunConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "resolved-runtime-key",
            models: [],
          },
        },
      },
    };
    setRuntimeConfigSnapshot(staleSnapshot, staleSnapshot);

    const resolved = buildEmbeddedRunBaseParams({
      run: makeRun(resolvedRunConfig),
      provider: "openai",
      model: "gpt-4.1-mini",
      runId: "run-1",
      authProfile: {},
    });

    expect(resolved.config).toBe(resolvedRunConfig);
  });
});
