import path from "node:path";
import { describe, expect, it } from "vitest";
import { rememberCodexRateLimits } from "./rate-limit-cache.js";
import {
  createParams,
  createStartedThreadHarness,
  rateLimitsUpdated,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt usage limits", () => {
  it("preserves Codex usage-limit reset details when turn/start fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const authProfileId = "openai-codex:work";
    const harnessRef: { current?: ReturnType<typeof createStartedThreadHarness> } = {};
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        if (!harnessRef.current) {
          throw new Error("Expected Codex app-server harness to be initialized");
        }
        void harnessRef.current.notify(rateLimitsUpdated(resetsAt));
        throw Object.assign(new Error("You've reached your usage limit."), {
          data: { codexErrorInfo: "usageLimitExceeded" },
        });
      }
      return undefined;
    });
    harnessRef.current = harness;

    const params = createParams(sessionFile, workspaceDir);
    params.authProfileId = authProfileId;
    params.authProfileStore = {
      version: 1,
      profiles: {
        [authProfileId]: {
          type: "oauth",
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      },
    };

    const result = await runCodexAppServerAttempt(params);
    expect(result.promptErrorSource).toBe("prompt");
    expect(result.promptError).toContain("You've reached your Codex subscription usage limit.");
    expect(result.promptError).toContain("Next reset in");
  });

  it("uses a recent Codex rate-limit snapshot when turn/start omits reset details", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const authProfileId = "openai-codex:work";
    rememberCodexRateLimits({
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
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        throw Object.assign(new Error("You've reached your usage limit."), {
          data: { codexErrorInfo: "usageLimitExceeded" },
        });
      }
      return undefined;
    });

    const params = createParams(sessionFile, workspaceDir);
    params.authProfileId = authProfileId;
    params.authProfileStore = {
      version: 1,
      profiles: {
        [authProfileId]: {
          type: "oauth",
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      },
    };

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const result = await run;
    expect(result.promptErrorSource).toBe("prompt");
    expect(result.promptError).toContain("You've reached your Codex subscription usage limit.");
    expect(result.promptError).toContain("Next reset in");
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
    expect(result.promptError).toContain("You've reached your Codex subscription usage limit.");
    expect(result.promptError).toContain("Next reset in");
    expect(result.promptError).not.toContain("Codex did not return a reset time");
  });

  it("refreshes Codex account rate limits when a failed turn omits reset details", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "account/rateLimits/read") {
        return rateLimitsUpdated(resetsAt).params;
      }
      return undefined;
    });

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
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

    expect(result.promptError).toContain("You've reached your Codex subscription usage limit.");
    expect(result.promptError).toContain("Next reset in");
    expect(result.promptError).not.toContain("Codex did not return a reset time");
    expect(harness.requests.some((request) => request.method === "account/rateLimits/read")).toBe(
      true,
    );
  });
});
