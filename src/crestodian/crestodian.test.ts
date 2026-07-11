// Crestodian tests cover main rescue and audit command behavior.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCrestodian, type RunCrestodianOptions } from "./crestodian.js";
import {
  createCrestodianTestRuntime,
  createCrestodianVerifiedInferenceTestFixture,
} from "./crestodian.test-helpers.js";
import { CrestodianInferenceUnavailableError } from "./inference-error.js";
import type { CrestodianCommandDeps } from "./operations.js";
import type { CrestodianOverview } from "./overview.js";

vi.mock("../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/providers.js")>()),
  resolveOwningPluginIdsForModelRefs: vi.fn(() => []),
  resolveOwningPluginIdsForProviderRef: vi.fn(() => []),
}));

const overview: CrestodianOverview = {
  defaultAgentId: "main",
  defaultModel: "openai/gpt-5.5",
  agents: [{ id: "main", isDefault: true, model: "openai/gpt-5.5" }],
  config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: null },
  tools: {
    codex: { command: "codex", found: false, error: "not found" },
    claude: { command: "claude", found: false, error: "not found" },
    gemini: { command: "gemini", found: false, error: "not found" },
    apiKeys: { openai: true, anthropic: false },
  },
  gateway: {
    url: "ws://127.0.0.1:18789",
    source: "local loopback",
    reachable: false,
    error: "offline",
  },
  references: {
    docsUrl: "https://docs.openclaw.ai",
    sourceUrl: "https://github.com/openclaw/openclaw",
  },
};

const crestodianOverviewDeps = {
  formatOverview: () => "Default model: openai/gpt-5.5",
  loadOverview: async () => overview,
};

const verifiedConfig = {
  agents: { defaults: { model: "openai/gpt-5.5" } },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
        auth: "api-key",
        models: [],
      },
    },
  },
} satisfies OpenClawConfig;

function configSnapshot(config: OpenClawConfig) {
  return {
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "h",
    config,
    runtimeConfig: config,
    sourceConfig: config,
    issues: [],
  };
}

async function createVerifiedRunOptions(deps: CrestodianCommandDeps = {}) {
  const fixture = await createCrestodianVerifiedInferenceTestFixture(verifiedConfig);
  return {
    verifiedInference: fixture.binding,
    deps: {
      ...fixture.deps,
      readConfigFileSnapshot: vi.fn(async () => configSnapshot(verifiedConfig)) as never,
      ...deps,
    },
  };
}

describe("runCrestodian", () => {
  it("rejects a missing inference binding before any runner side effect", async () => {
    const { runtime } = createCrestodianTestRuntime();
    const loadOverview = vi.fn(async () => overview);
    const planWithAssistant = vi.fn(async () => ({ command: "restart gateway" }));
    const runGatewayRestart = vi.fn(async () => {});
    const runInteractiveTui = vi.fn(async () => {});
    const common = {
      deps: { loadOverview, runGatewayRestart },
      planWithAssistant,
      runInteractiveTui,
      input: { isTTY: true } as unknown as NodeJS.ReadableStream,
      output: { isTTY: true } as unknown as NodeJS.WritableStream,
    };
    const withoutBinding = (opts: Omit<RunCrestodianOptions, "verifiedInference">) =>
      opts as RunCrestodianOptions;

    await expect(
      runCrestodian(withoutBinding({ ...common, json: true }), runtime),
    ).rejects.toBeInstanceOf(CrestodianInferenceUnavailableError);
    await expect(
      runCrestodian(withoutBinding({ ...common, message: "please make things nicer" }), runtime),
    ).rejects.toBeInstanceOf(CrestodianInferenceUnavailableError);
    await expect(
      runCrestodian(withoutBinding({ ...common, message: "restart gateway", yes: true }), runtime),
    ).rejects.toBeInstanceOf(CrestodianInferenceUnavailableError);
    await expect(runCrestodian(withoutBinding(common), runtime)).rejects.toBeInstanceOf(
      CrestodianInferenceUnavailableError,
    );

    expect(loadOverview).not.toHaveBeenCalled();
    expect(planWithAssistant).not.toHaveBeenCalled();
    expect(runGatewayRestart).not.toHaveBeenCalled();
    expect(runInteractiveTui).not.toHaveBeenCalled();
  });

  it("uses the assistant planner only to choose typed operations", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    let runGatewayRestartCalls = 0;
    let onReadyCalls = 0;
    const verified = await createVerifiedRunOptions({
      runGatewayRestart: async () => {
        runGatewayRestartCalls += 1;
      },
    });

    await runCrestodian(
      {
        ...verified,
        message: "the local bridge looks sleepy, poke it",
        onReady: () => {
          onReadyCalls += 1;
        },
        planWithAssistant: async () => ({
          reply: "I can queue a Gateway restart.",
          command: "restart gateway",
          modelLabel: "openai/gpt-5.5",
        }),
        ...crestodianOverviewDeps,
      },
      runtime,
    );

    expect(runGatewayRestartCalls).toBe(0);
    expect(onReadyCalls).toBe(0);
    expect(lines.join("\n")).toContain("[crestodian] planner: openai/gpt-5.5");
    expect(lines.join("\n")).toContain("[crestodian] interpreted: restart gateway");
    expect(lines.join("\n")).toContain("Plan: restart the Gateway. Say yes to apply.");
    expect(lines.indexOf("Default model: openai/gpt-5.5")).toBeLessThan(
      lines.findIndex((line) => line.includes("[crestodian] planner:")),
    );
  });

  it("does not apply a one-shot plan after the verified route changes", async () => {
    const { runtime } = createCrestodianTestRuntime();
    const changedConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce(configSnapshot(verifiedConfig))
      .mockResolvedValue(configSnapshot(changedConfig));
    const runGatewayRestart = vi.fn(async () => {});
    const verified = await createVerifiedRunOptions({
      readConfigFileSnapshot: readConfigFileSnapshot as never,
      runGatewayRestart,
    });

    await expect(
      runCrestodian(
        {
          ...verified,
          message: "the bridge looks sleepy, restart it",
          yes: true,
          planWithAssistant: async () => ({ command: "restart gateway" }),
          ...crestodianOverviewDeps,
        },
        runtime,
      ),
    ).rejects.toBeInstanceOf(CrestodianInferenceUnavailableError);
    expect(runGatewayRestart).not.toHaveBeenCalled();
  });

  it("rechecks one-shot authority at the persistent apply boundary", async () => {
    const { runtime } = createCrestodianTestRuntime();
    const changedConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce(configSnapshot(verifiedConfig))
      .mockResolvedValueOnce(configSnapshot(verifiedConfig))
      .mockResolvedValue(configSnapshot(changedConfig));
    const runGatewayRestart = vi.fn(async () => {});
    const verified = await createVerifiedRunOptions({
      readConfigFileSnapshot: readConfigFileSnapshot as never,
      runGatewayRestart,
    });

    await expect(
      runCrestodian(
        {
          ...verified,
          message: "the bridge looks sleepy, restart it",
          yes: true,
          planWithAssistant: async () => ({ command: "restart gateway" }),
          ...crestodianOverviewDeps,
        },
        runtime,
      ),
    ).rejects.toBeInstanceOf(CrestodianInferenceUnavailableError);

    expect(readConfigFileSnapshot).toHaveBeenCalledTimes(3);
    expect(runGatewayRestart).not.toHaveBeenCalled();
  });

  it("keeps exact one-shot parsing ahead of the assistant planner", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    let plannerCalls = 0;
    let onReadyCalls = 0;
    const verified = await createVerifiedRunOptions();

    await runCrestodian(
      {
        ...verified,
        message: "models",
        planWithAssistant: async () => {
          plannerCalls += 1;
          return { command: "restart gateway" };
        },
        onReady: () => {
          onReadyCalls += 1;
        },
        ...crestodianOverviewDeps,
      },
      runtime,
    );

    expect(plannerCalls).toBe(0);
    expect(onReadyCalls).toBe(0);
    expect(lines.join("\n")).toContain("Default model:");
  });

  it("prints an explicit one-shot overview exactly once", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    const verified = await createVerifiedRunOptions();

    await runCrestodian(
      {
        ...verified,
        message: "overview",
        formatOverview: () => "formatted overview",
        loadOverview: async () => overview,
      },
      runtime,
    );

    expect(lines).toEqual(["formatted overview"]);
  });

  it.each([
    { name: "no plan", plan: null },
    { name: "invalid command", plan: { command: "invent a new operation" } },
  ])("fails a fuzzy one-shot when inference returns $name", async ({ plan }) => {
    const { runtime } = createCrestodianTestRuntime();
    const verified = await createVerifiedRunOptions();

    await expect(
      runCrestodian(
        {
          ...verified,
          message: "please make things nicer",
          planWithAssistant: async () => plan,
          ...crestodianOverviewDeps,
        },
        runtime,
      ),
    ).rejects.toBeInstanceOf(CrestodianInferenceUnavailableError);
  });

  it("prints a valid reply-only one-shot plan", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    const verified = await createVerifiedRunOptions();

    await runCrestodian(
      {
        ...verified,
        message: "explain the current setup",
        planWithAssistant: async () => ({ reply: "The current setup is healthy." }),
        ...crestodianOverviewDeps,
      },
      runtime,
    );

    expect(lines).toEqual(["Default model: openai/gpt-5.5", "", "The current setup is healthy."]);
  });

  it("does not print a reply-only plan after its inference owner drifts", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    const changedConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    let currentConfig: OpenClawConfig = verifiedConfig;
    const verified = await createVerifiedRunOptions({
      readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
    });

    await expect(
      runCrestodian(
        {
          ...verified,
          message: "explain the current setup",
          planWithAssistant: async () => {
            currentConfig = changedConfig;
            return { reply: "stale reply" };
          },
          ...crestodianOverviewDeps,
        },
        runtime,
      ),
    ).rejects.toBeInstanceOf(CrestodianInferenceUnavailableError);
    expect(lines).not.toContain("stale reply");
  });

  it("starts interactive Crestodian in the TUI shell", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    let runInteractiveTuiCalls = 0;
    let onReadyCalls = 0;
    const verified = await createVerifiedRunOptions();

    await runCrestodian(
      {
        ...verified,
        input: { isTTY: true } as unknown as NodeJS.ReadableStream,
        output: { isTTY: true } as unknown as NodeJS.WritableStream,
        runInteractiveTui: async () => {
          runInteractiveTuiCalls += 1;
        },
        onReady: () => {
          onReadyCalls += 1;
        },
      },
      runtime,
    );

    expect(runInteractiveTuiCalls).toBe(1);
    expect(onReadyCalls).toBe(1);
    expect(lines.join("\n")).not.toContain("Say: status");
  });

  it("prints the formatted overview exactly once when interactive mode is disabled", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    let loadOverviewCalls = 0;
    let runInteractiveTuiCalls = 0;
    const verified = await createVerifiedRunOptions();

    await runCrestodian(
      {
        ...verified,
        interactive: false,
        loadOverview: async () => {
          loadOverviewCalls += 1;
          return overview;
        },
        formatOverview: () => "formatted overview",
        runInteractiveTui: async () => {
          runInteractiveTuiCalls += 1;
        },
      },
      runtime,
    );

    expect(loadOverviewCalls).toBe(1);
    expect(runInteractiveTuiCalls).toBe(0);
    expect(lines).toEqual(["formatted overview"]);
  });

  it.each([
    {
      name: "stdin is not a TTY",
      input: { isTTY: false } as unknown as NodeJS.ReadableStream,
      output: { isTTY: true } as unknown as NodeJS.WritableStream,
      interactive: true,
    },
    {
      name: "stdout is not a TTY",
      input: { isTTY: true } as unknown as NodeJS.ReadableStream,
      output: { isTTY: false } as unknown as NodeJS.WritableStream,
      interactive: true,
    },
  ])("exits non-zero when $name", async ({ input, output, interactive }) => {
    const { runtime, lines } = createCrestodianTestRuntime();
    let runInteractiveTuiCalls = 0;
    const verified = await createVerifiedRunOptions();

    await expect(
      runCrestodian(
        {
          ...verified,
          input,
          output,
          interactive,
          runInteractiveTui: async () => {
            runInteractiveTuiCalls += 1;
          },
        },
        runtime,
      ),
    ).rejects.toThrow("exit 1");

    expect(runInteractiveTuiCalls).toBe(0);
    expect(lines.join("\n")).toContain(
      "Crestodian needs an interactive TTY. Use --message for one command.",
    );
  });
});
