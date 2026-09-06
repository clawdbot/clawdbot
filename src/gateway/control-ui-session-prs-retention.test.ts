import { getEventListeners } from "node:events";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createControlUiSessionPullRequestSubscriptions } from "./control-ui-session-pr-subscriptions.js";
import { loadControlUiSessionPullRequests } from "./control-ui-session-prs.js";
import {
  evictPullRequestCache,
  githubJson,
  pullListItem,
  routedFetch,
} from "./control-ui-session-prs.test-support.js";

let cacheEpochMs = Date.now();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  cacheEpochMs += 10 * 60_000;
  vi.setSystemTime(cacheEpochMs);
});

afterEach(async () => {
  await evictPullRequestCache();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("watched session PR retention", () => {
  it("keeps every watched branch's last-good chips through quota backoff", async () => {
    let limited = false;
    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          limited
            ? githubJson({}, 429)
            : githubJson([pullListItem({ merged_at: "2026-07-09T10:00:00Z" })]),
      },
    ]);
    const snapshots = new Map<string, { rateLimited: boolean; pullRequests: unknown[] }>();
    const subscriptions = createControlUiSessionPullRequestSubscriptions({
      broadcastToConnIds: (_event, payload) => {
        if (!isRecord(payload) || !isRecord(payload.sessions)) {
          throw new Error("invalid subscription event");
        }
        for (const [key, snapshot] of Object.entries(payload.sessions)) {
          if (
            !isRecord(snapshot) ||
            typeof snapshot.rateLimited !== "boolean" ||
            !Array.isArray(snapshot.pullRequests)
          ) {
            throw new Error("invalid subscription snapshot");
          }
          snapshots.set(key, {
            rateLimited: snapshot.rateLimited,
            pullRequests: snapshot.pullRequests,
          });
        }
      },
      load: (params, cacheSignal) =>
        loadControlUiSessionPullRequests(params, {
          cacheSignal,
          fetchImpl,
          resolveGitContext: async () => ({
            owner: "openclaw",
            repo: "openclaw",
            branch: params.sessionKey,
          }),
        }),
    });
    const keys = Array.from({ length: 101 }, (_, index) => `quota-${index}`);
    try {
      await subscriptions.replace("watcher", keys);
      expect(fetchImpl.mock.calls).toHaveLength(101);
      limited = true;
      vi.setSystemTime(Date.now() + 90_001);
      await subscriptions.pollNow();
      const callsAtBackoff = fetchImpl.mock.calls.length;
      expect(callsAtBackoff).toBeGreaterThan(101);
      expect(
        [...snapshots.values()].every(
          (snapshot) => snapshot.rateLimited && snapshot.pullRequests.length === 1,
        ),
      ).toBe(true);
      vi.setSystemTime(Date.now() + 61_000);
      await subscriptions.replace("watcher", keys, new Set(keys));
      expect(fetchImpl.mock.calls).toHaveLength(callsAtBackoff);
      expect(
        [...snapshots.values()].every(
          (snapshot) => snapshot.rateLimited && snapshot.pullRequests.length === 1,
        ),
      ).toBe(true);
      limited = false;
      vi.setSystemTime(Date.now() + 240_001);
      await subscriptions.pollNow();
      expect(fetchImpl.mock.calls).toHaveLength(callsAtBackoff + 101);
      expect(
        [...snapshots.values()].every(
          (snapshot) => !snapshot.rateLimited && snapshot.pullRequests.length === 1,
        ),
      ).toBe(true);
    } finally {
      await subscriptions.stop();
    }
  });

  it("retains GitHub snapshots for the watched union across a poll", async () => {
    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () => githubJson([pullListItem({ merged_at: "2026-07-09T10:00:00Z" })]),
      },
    ]);
    const signals = new Set<AbortSignal>();
    const gitOutput = vi.fn(async (root: string, args: string[]) => {
      if (args.includes("--abbrev-ref")) {
        return root.slice("/watched/".length);
      }
      if (args[0] === "remote") {
        return "https://github.com/openclaw/openclaw.git";
      }
      if (args[0] === "symbolic-ref") {
        return "origin/main";
      }
      return null;
    });
    const resolveBranchLanding = vi.fn(async () => ({
      pushedSha: null,
      statsBase: null,
      hasLandedPullRequest: true,
      provenNewPushedWork: false,
    }));
    const subscriptions = createControlUiSessionPullRequestSubscriptions({
      broadcastToConnIds: vi.fn(),
      load: (params, cacheSignal) => {
        if (cacheSignal) {
          signals.add(cacheSignal);
        }
        return loadControlUiSessionPullRequests(params, {
          cacheSignal,
          fetchImpl,
          gitOutput,
          resolveBranchLanding,
          resolveGitRoot: async () => `/watched/${params.sessionKey}`,
        });
      },
    });
    try {
      await subscriptions.replace(
        "first",
        Array.from({ length: 200 }, (_, index) => `watched-${index}`),
      );
      await subscriptions.replace(
        "second",
        Array.from({ length: 100 }, (_, index) => `watched-${index + 200}`),
      );
      expect(fetchImpl.mock.calls).toHaveLength(300);
      expect(gitOutput).toHaveBeenCalledTimes(900);
      expect(resolveBranchLanding).toHaveBeenCalledTimes(300);

      vi.setSystemTime(Date.now() + 60_000);
      await subscriptions.pollNow();

      expect(fetchImpl.mock.calls).toHaveLength(300);
      expect(gitOutput).toHaveBeenCalledTimes(900);
      expect(resolveBranchLanding).toHaveBeenCalledTimes(300);

      vi.setSystemTime(Date.now() + 15_001);
      await subscriptions.pollNow();
      expect(fetchImpl.mock.calls).toHaveLength(300);
      expect(gitOutput).toHaveBeenCalledTimes(1_800);
      expect(resolveBranchLanding).toHaveBeenCalledTimes(600);
      expect(signals.size).toBe(300);
      expect([...signals].every((signal) => getEventListeners(signal, "abort").length === 3)).toBe(
        true,
      );
    } finally {
      await subscriptions.stop();
    }
    expect(
      [...signals].every(
        (signal) => signal.aborted && getEventListeners(signal, "abort").length === 0,
      ),
    ).toBe(true);
  });

  it("releases obsolete retained facts when a watched checkout changes or disappears", async () => {
    const cacheLifetime = new AbortController();
    let root: string | null = "/retained/first";
    let branch: string | null = "feature-a";
    let rootFailure = false;
    let fetchFailure = false;
    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () => githubJson(fetchFailure ? {} : [], fetchFailure ? 503 : 200),
      },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);
    const load = () =>
      loadControlUiSessionPullRequests(
        { sessionKey: "retained", refresh: true },
        {
          cacheSignal: cacheLifetime.signal,
          fetchImpl,
          resolveGitRoot: async () => {
            if (rootFailure) {
              throw new Error("session unavailable");
            }
            return root;
          },
          gitOutput: async (_root, args) =>
            args[0] === "rev-parse"
              ? branch
              : args[0] === "remote"
                ? "https://github.com/openclaw/openclaw.git"
                : "origin/main",
          resolveBranchLanding: async () => ({
            pushedSha: null,
            statsBase: null,
            hasLandedPullRequest: false,
            provenNewPushedWork: false,
          }),
        },
      );
    const pins = () => getEventListeners(cacheLifetime.signal, "abort").length;
    try {
      await load();
      expect(pins()).toBe(3);
      root = "/retained/second";
      branch = "feature-b";
      await load();
      expect(pins()).toBe(3);
      root = null;
      await load();
      expect(pins()).toBe(0);
      root = "/retained/third";
      branch = "feature-c";
      fetchFailure = true;
      await expect(load()).rejects.toMatchObject({ statusCode: 502 });
      // Preserve context and the GitHub failure's expiry, but drop obsolete branch facts.
      expect(pins()).toBe(2);
      fetchFailure = false;
      vi.setSystemTime(Date.now() + 30_001);
      await load();
      expect(pins()).toBe(3);
      branch = null;
      await load();
      expect(pins()).toBe(1);
      rootFailure = true;
      await expect(load()).rejects.toThrow("session unavailable");
      expect(pins()).toBe(0);
    } finally {
      cacheLifetime.abort();
    }
  });
});
