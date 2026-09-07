import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderUsageFetch } from "../test-utils/provider-usage-fetch.js";

const fetchFn = createProviderUsageFetch(() => {
  throw new Error("SDK forwarding must use the selected execution owner");
});
const usageArgs = ["sdk-usage-token", 137, fetchFn] as const;
const codexArgs = [usageArgs[0], "sdk-account", usageArgs[1], fetchFn] as const;
const geminiArgs = [...usageArgs, "openai"] as const;
const minimaxArgs = [...usageArgs, { baseUrl: "https://usage.example/anthropic" }] as const;
const preparationParams = {
  cfg: { agents: { defaults: { model: "synthetic/model" } } },
  agentId: "sdk-agent",
  agentDir: "/tmp/sdk-agent",
  modelRef: "synthetic/model@profile",
  useUtilityModel: true,
  preferredProfile: "synthetic:preferred",
  allowMissingApiKeyModes: ["aws-sdk"],
  allowBundledStaticCatalogFallback: true,
  useAsyncModelResolution: true,
  skipAgentDiscovery: true,
  bindAuthOwner: true,
} satisfies Parameters<
  typeof import("./simple-completion-runtime.js").prepareSimpleCompletionModelForAgent
>[0];

const cases = [
  {
    name: "fetchClaudeUsage",
    owner: "../infra/provider-usage.fetch.claude.js",
    args: usageArgs,
    load: async () => {
      const sdk = await import("./provider-usage.js");
      return () => sdk.fetchClaudeUsage(...usageArgs);
    },
  },
  {
    name: "fetchCodexUsage",
    owner: "../infra/provider-usage.fetch.codex.js",
    args: codexArgs,
    load: async () => {
      const sdk = await import("./provider-usage.js");
      return () => sdk.fetchCodexUsage(...codexArgs);
    },
  },
  {
    name: "fetchDeepSeekUsage",
    owner: "../infra/provider-usage.fetch.deepseek.js",
    args: usageArgs,
    load: async () => {
      const sdk = await import("./provider-usage.js");
      return () => sdk.fetchDeepSeekUsage(...usageArgs);
    },
  },
  {
    name: "fetchGeminiUsage",
    owner: "../infra/provider-usage.fetch.gemini.js",
    args: geminiArgs,
    load: async () => {
      const sdk = await import("./provider-usage.js");
      return () => sdk.fetchGeminiUsage(...geminiArgs);
    },
  },
  {
    name: "fetchMinimaxUsage",
    owner: "../infra/provider-usage.fetch.minimax.js",
    args: minimaxArgs,
    load: async () => {
      const sdk = await import("./provider-usage.js");
      return () => sdk.fetchMinimaxUsage(...minimaxArgs);
    },
  },
  {
    name: "fetchZaiUsage",
    owner: "../infra/provider-usage.fetch.zai.js",
    args: usageArgs,
    load: async () => {
      const sdk = await import("./provider-usage.js");
      return () => sdk.fetchZaiUsage(...usageArgs);
    },
  },
  {
    name: "prepareSimpleCompletionModelForAgent",
    owner: "../agents/simple-completion-runtime.js",
    args: [preparationParams],
    load: async () => {
      const sdk = await import("./simple-completion-runtime.js");
      return () => sdk.prepareSimpleCompletionModelForAgent(preparationParams);
    },
  },
];

beforeEach(() => {
  vi.resetModules();
  fetchFn.mockClear();
});

afterEach(() => {
  for (const testCase of cases) {
    vi.doUnmock(testCase.owner);
  }
  vi.resetModules();
});

describe("lazy SDK execution facades", () => {
  it.each(cases)(
    "defers $name to its execution owner and preserves arguments and outcomes",
    async (testCase) => {
      const loaded: string[] = [];
      const resolvedError = {
        provider: "openai",
        displayName: "SDK fixture",
        windows: [],
        error: "Owner unavailable",
      };
      const failure = new Error("Owner request failed");
      const execute = vi.fn<(...args: unknown[]) => Promise<unknown>>();
      execute.mockResolvedValueOnce(resolvedError).mockRejectedValueOnce(failure);
      for (const entry of cases) {
        vi.doMock(entry.owner, () => {
          loaded.push(entry.owner);
          return { [entry.name]: execute };
        });
      }

      const invoke = await testCase.load();
      expect(loaded).toEqual([]);
      expect(execute).not.toHaveBeenCalled();

      await expect(invoke()).resolves.toBe(resolvedError);
      await expect(invoke()).rejects.toBe(failure);

      expect(loaded).toEqual([testCase.owner]);
      expect(execute).toHaveBeenCalledTimes(2);
      for (const call of execute.mock.calls) {
        expect(call).toHaveLength(testCase.args.length);
        for (const [index, argument] of testCase.args.entries()) {
          expect(call[index]).toBe(argument);
        }
      }
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );
});
