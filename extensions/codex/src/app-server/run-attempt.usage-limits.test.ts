// Codex tests cover run attempt.usage limits plugin behavior.
import path from "node:path";
import { saveAuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { describe, expect, it } from "vitest";
import { readCodexRateLimitsRevision, rememberCodexRateLimitsRead } from "./rate-limit-cache.js";
import {
  createParams,
  createStartedThreadHarness,
  rateLimitsUpdated,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

function expectUsageLimitPromptError(value: unknown): Error & { status: 429 } {
  expect(value).toBeInstanceOf(Error);
  const error = value as Error & { status?: unknown };
  expect(error.status).toBe(429);
  return error as Error & { status: 429 };
}

describe("runCodexAppServerAttempt usage limits", () => {
  it("preserves Codex usage-limit reset details when turn/start fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const authProfileId = "openai:work";
    const harnessRef: { current?: ReturnType<typeof createStartedThreadHarness> } = {};
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        if (!harnessRef.current) {
          throw new Error("Expected Codex app-server harness to be initialized");
        }
        const revisionBeforeUpdate = readCodexRateLimitsRevision(harnessRef.current.client);
        await harnessRef.current.notify(rateLimitsUpdated(resetsAt));
        expect(readCodexRateLimitsRevision(harnessRef.current.client)).toBe(
          revisionBeforeUpdate + 1,
        );
        throw Object.assign(new Error("You've reached your usage limit."), {
          data: { codexErrorInfo: "usageLimitExceeded" },
        });
      }
      return undefined;
    });
    harnessRef.current = harness;

    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = path.join(tempDir, "agent");
    params.authProfileId = authProfileId;
    params.authProfileStore = {
      version: 1,
      profiles: {
        [authProfileId]: {
          type: "oauth",
          provider: "openai",
          access: "placeholder",
          refresh: "placeholder",
          expires: Date.now() + 60_000,
        },
      },
    };

    const result = await runCodexAppServerAttempt(params);
    expect(result.promptErrorSource).toBe("prompt");
    const promptError = expectUsageLimitPromptError(result.promptError);
    expect(promptError.message).toContain("You've reached your Codex subscription usage limit.");
    expect(promptError.message).toContain("Next reset in");
  });

  it("uses a recent Codex rate-limit snapshot when turn/start omits reset details", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const authProfileId = "openai:work";
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        throw Object.assign(new Error("You've reached your usage limit."), {
          data: { codexErrorInfo: "usageLimitExceeded" },
        });
      }
      return undefined;
    });
    rememberCodexRateLimitsRead(harness.client, {
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt },
        secondary: null,
        credits: null,
        planType: "plus",
        rateLimitReachedType: "rate_limit_reached",
      },
      rateLimitsByLimitId: null,
    });

    const params = createParams(sessionFile, workspaceDir);
    params.authProfileId = authProfileId;
    params.authProfileStore = {
      version: 1,
      profiles: {
        [authProfileId]: {
          type: "oauth",
          provider: "openai",
          access: "placeholder",
          refresh: "placeholder",
          expires: Date.now() + 60_000,
        },
      },
    };

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const result = await run;
    expect(result.promptErrorSource).toBe("prompt");
    const promptError = expectUsageLimitPromptError(result.promptError);
    expect(promptError.message).toContain("You've reached your Codex subscription usage limit.");
    expect(promptError.message).toContain("Next reset in");
    expect(params.authProfileStore.usageStats?.[authProfileId]?.blockedUntil).toBeUndefined();
  });

  it("does not trust an unrelated in-turn rate-limit update for profile blocking", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const authProfileId = "openai:work";
    const harnessRef: { current?: ReturnType<typeof createStartedThreadHarness> } = {};
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        if (!harnessRef.current) {
          throw new Error("Expected Codex app-server harness to be initialized");
        }
        await harnessRef.current.notify({
          method: "account/rateLimits/updated",
          params: {
            rateLimits: {
              limitId: "codex_other",
              primary: { usedPercent: 100, windowDurationMins: 60, resetsAt: resetsAt + 60 },
              rateLimitReachedType: "rate_limit_reached",
            },
          },
        });
        throw Object.assign(new Error("You've reached your usage limit."), {
          data: { codexErrorInfo: "usageLimitExceeded" },
        });
      }
      return undefined;
    });
    harnessRef.current = harness;
    rememberCodexRateLimitsRead(harness.client, {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt },
        rateLimitReachedType: "rate_limit_reached",
      },
    });
    const params = createParams(sessionFile, workspaceDir);
    params.authProfileId = authProfileId;
    params.authProfileStore = {
      version: 1,
      profiles: {
        [authProfileId]: {
          type: "oauth",
          provider: "openai",
          access: "placeholder",
          refresh: "placeholder",
          expires: Date.now() + 60_000,
        },
      },
    };

    const result = await runCodexAppServerAttempt(params);

    expect(expectUsageLimitPromptError(result.promptError).message).toContain("Next reset in");
    expect(params.authProfileStore.usageStats?.[authProfileId]?.blockedUntil).toBeUndefined();
  });

  it("refreshes Codex account rate limits when turn/start omits reset details", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        throw Object.assign(new Error("You've reached your usage limit."), {
          data: { codexErrorInfo: "usageLimitExceeded" },
        });
      }
      if (method === "account/rateLimits/read") {
        return rateLimitsUpdated(resetsAt).params;
      }
      return undefined;
    });

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await harness.waitForMethod("account/rateLimits/read");

    const result = await run;
    expect(result.promptErrorSource).toBe("prompt");
    const promptError = expectUsageLimitPromptError(result.promptError);
    expect(promptError.message).toContain("You've reached your Codex subscription usage limit.");
    expect(promptError.message).toContain("Next reset in");
    expect(promptError.message).not.toContain("Codex did not return a reset time");
  });

  it("refreshes Codex account rate limits when a failed turn omits reset details", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const authProfileId = "openai:work";
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "account/rateLimits/read") {
        return rateLimitsUpdated(resetsAt).params;
      }
      return undefined;
    });

    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = path.join(tempDir, "streamed-usage-limit-agent");
    params.authProfileId = authProfileId;
    params.authProfileStore = {
      version: 1,
      profiles: {
        [authProfileId]: {
          type: "oauth",
          provider: "openai",
          access: "placeholder",
          refresh: "placeholder",
          expires: Date.now() + 60_000,
        },
      },
    };
    saveAuthProfileStore(params.authProfileStore, params.agentDir);
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "failed",
          error: {
            message: "You've reached your usage limit.",
            codexErrorInfo: "usageLimitExceeded",
          },
        },
      },
    });

    const result = await run;

    const promptError = expectUsageLimitPromptError(result.promptError);
    expect(promptError.message).toContain("You've reached your Codex subscription usage limit.");
    expect(promptError.message).toContain("Next reset in");
    expect(promptError.message).not.toContain("Codex did not return a reset time");
    expect(params.authProfileStore.usageStats?.[authProfileId]?.blockedUntil).toBe(resetsAt * 1000);
    expect(harness.requests.some((request) => request.method === "account/rateLimits/read")).toBe(
      true,
    );
  });

  it("blocks after a streamed usage-limit failure with trusted in-turn limits", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const authProfileId = "openai:work";
    const harness = createStartedThreadHarness(async () => undefined);
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = path.join(tempDir, "trusted-streamed-usage-limit-agent");
    params.authProfileId = authProfileId;
    params.authProfileStore = {
      version: 1,
      profiles: {
        [authProfileId]: {
          type: "oauth",
          provider: "openai",
          access: "placeholder",
          refresh: "placeholder",
          expires: Date.now() + 60_000,
        },
      },
    };
    saveAuthProfileStore(params.authProfileStore, params.agentDir);

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify(rateLimitsUpdated(resetsAt));
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "failed",
          error: {
            message: "You've reached your usage limit.",
            codexErrorInfo: "usageLimitExceeded",
          },
        },
      },
    });

    const result = await run;

    expect(expectUsageLimitPromptError(result.promptError).message).toContain("Next reset in");
    expect(params.authProfileStore.usageStats?.[authProfileId]?.blockedUntil).toBe(resetsAt * 1000);
    expect(harness.requests.some((request) => request.method === "account/rateLimits/read")).toBe(
      false,
    );
  });

  it("does not block after a streamed usage-limit failure with only stale limits", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const authProfileId = "openai:work";
    const harness = createStartedThreadHarness(async () => undefined);
    rememberCodexRateLimitsRead(harness.client, rateLimitsUpdated(resetsAt).params);
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = path.join(tempDir, "stale-streamed-usage-limit-agent");
    params.authProfileId = authProfileId;
    params.authProfileStore = {
      version: 1,
      profiles: {
        [authProfileId]: {
          type: "oauth",
          provider: "openai",
          access: "placeholder",
          refresh: "placeholder",
          expires: Date.now() + 60_000,
        },
      },
    };

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "failed",
          error: {
            message: "You've reached your usage limit.",
            codexErrorInfo: "usageLimitExceeded",
          },
        },
      },
    });

    const result = await run;

    expect(expectUsageLimitPromptError(result.promptError).message).toContain("Next reset in");
    expect(params.authProfileStore.usageStats?.[authProfileId]?.blockedUntil).toBeUndefined();
    expect(harness.requests.some((request) => request.method === "account/rateLimits/read")).toBe(
      false,
    );
  });
});
