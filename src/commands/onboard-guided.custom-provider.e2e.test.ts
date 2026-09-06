import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureFullEnv, setTestEnvValue } from "../test-utils/env.js";

const cleanupTasks: Array<() => Promise<void>> = [];
const model = "fixture-model";

afterEach(async () => {
  await Promise.allSettled(cleanupTasks.splice(0).map((cleanup) => cleanup()));
  vi.resetModules();
});

type Scenario = {
  protocol: "openai" | "openai-responses" | "anthropic";
  secretRef?: boolean;
  authless?: boolean;
  outcome?: "fail" | "cancel" | "prompt-cancel";
  surface?: "cli" | "gateway";
  authMetadata?: "order-only" | "store-only";
};

async function runCustomSetup(scenario: Scenario) {
  const { WizardCancelledError } = await import("../wizard/prompts.js");
  const credential = `fixture-${scenario.protocol}-${scenario.outcome ?? "success"}-${scenario.secretRef ? "ref" : "literal"}`;
  const env = captureFullEnv();
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "guided-custom-")));
  const configPath = path.join(root, "openclaw.json");
  const workspace = path.join(root, "workspace");
  const requests: Array<{ stream: boolean; pathname: string; authorized: boolean }> = [];
  const serverErrors: unknown[] = [];
  const controller = new AbortController();
  const initialConfig: OpenClawConfig = {
    gateway: { mode: "local" },
    plugins: { slots: { memory: "none" } },
    agents: {
      defaults: { workspace, skipBootstrap: true, skills: [], model: "prior/working-model" },
    },
    models: {
      providers: {
        prior: {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "prior-fixture-credential",
          models: [],
        },
      },
    },
  };
  if (scenario.surface === "gateway") {
    initialConfig.auth = {
      ...(scenario.authMetadata
        ? {}
        : {
            profiles: {
              "fixture-custom:ambient": { provider: "fixture-custom", mode: "api_key" as const },
            },
          }),
      ...(scenario.authMetadata === "store-only"
        ? {}
        : { order: { "fixture-custom": ["fixture-custom:ambient"] } }),
    };
  }
  const initialBytes = `${JSON.stringify(initialConfig)}\n`;
  await fs.mkdir(workspace);
  await fs.writeFile(configPath, initialBytes);
  setTestEnvValue("OPENCLAW_STATE_DIR", root);
  setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
  setTestEnvValue("CUSTOM_SETUP_FIXTURE_KEY", credential);
  if (scenario.surface === "gateway") {
    setTestEnvValue("CUSTOM_API_KEY", "ambient-host-key");
    setTestEnvValue("FIXTURE_CUSTOM_API_KEY", "ambient-host-key");
    const { upsertAuthProfileWithLockOrThrow } =
      await import("../agents/auth-profiles/profiles.js");
    await upsertAuthProfileWithLockOrThrow({
      profileId: "fixture-custom:ambient",
      credential: { type: "api_key", provider: "fixture-custom", key: "ambient-host-key" },
      stateDir: root,
    });
  }

  const server = createServer((request, response) => {
    void (async () => {
      let raw = "";
      for await (const chunk of request) {
        raw += String(chunk);
      }
      const body = JSON.parse(raw) as { stream?: boolean; model?: string };
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      expect(pathname).toBe(
        {
          openai: "/v1/chat/completions",
          "openai-responses": "/v1/responses",
          anthropic: "/v1/messages",
        }[scenario.protocol],
      );
      const authorized = scenario.authless
        ? request.headers.authorization === undefined
        : scenario.protocol === "anthropic"
          ? request.headers["x-api-key"] === credential
          : request.headers.authorization === `Bearer ${credential}`;
      requests.push({ stream: body.stream === true, pathname, authorized });
      expect(body.model).toBe(model);
      expect(await fs.readFile(configPath, "utf8")).toBe(initialBytes);
      if (!body.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      if (scenario.outcome === "fail") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `Rejected credential ${credential}` } }));
        return;
      }
      if (scenario.outcome === "cancel") {
        controller.abort();
      }
      writeCompletion(response, scenario.protocol);
    })().catch((error: unknown) => {
      serverErrors.push(error);
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanupTasks.push(async () => {
    env.restore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await fs.rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("custom provider fixture did not bind");
  }
  const baseUrl = `http://127.0.0.1:${address.port}${scenario.protocol === "anthropic" ? "" : "/v1"}`;
  const textAnswers = [
    baseUrl,
    scenario.authless ? "" : scenario.secretRef ? "CUSTOM_SETUP_FIXTURE_KEY" : credential,
    model,
    "fixture-custom",
    "fixture-alias",
  ];
  const selectAnswers = [
    "custom",
    ...(scenario.surface === "gateway"
      ? [scenario.protocol]
      : [...(scenario.secretRef ? ["ref", "env"] : ["plaintext"]), scenario.protocol]),
    "skip",
  ];
  const prompter = createWizardPrompter({
    text: vi.fn(async (params) => {
      if (scenario.outcome === "prompt-cancel" && textAnswers.length === 2) {
        throw new WizardCancelledError("cancelled");
      }
      const answer = textAnswers.shift() ?? "";
      expect(await params.validate?.(answer)).toBeUndefined();
      return answer;
    }),
    select: async (params) => {
      const value = selectAnswers.shift();
      expect(params.options.map((option) => option.value)).toContain(value);
      return value as never;
    },
  });
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number): never => {
      throw new Error(`unexpected exit ${code}`);
    },
  };
  const configModule = await import("../config/config.js");
  configModule.clearConfigCache();
  const { activateSetupInference } = await import("../system-agent/setup-inference.js");
  const { runManualStage } = await import("./onboard-guided-manual.js");
  const activationResults: unknown[] = [];
  const resultPromise = runManualStage({
    detection: {
      candidates: [],
      unavailableCandidates: [],
      recommendedInstalls: [],
      manualProviders: [],
      authOptions: [],
      workspace,
      setupComplete: true,
    },
    autoAttemptedKinds: new Set(),
    config: initialConfig,
    workspace,
    prompter,
    runtime,
    hasActiveRoute: true,
    activate: async (params) => {
      const result = await activateSetupInference({
        ...params,
        surface: scenario.surface ?? "cli",
        signal: controller.signal,
      });
      activationResults.push(result);
      return result;
    },
  });
  const result =
    scenario.outcome === "prompt-cancel"
      ? await resultPromise.catch((error: unknown) => error)
      : await resultPromise;
  expect(serverErrors).toEqual([]);
  return {
    result,
    credential,
    cancelled: result instanceof WizardCancelledError,
    requests,
    initialConfig,
    activationResults,
    textPrompts: vi.mocked(prompter.text).mock.calls,
    config: JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig,
    output: JSON.stringify([
      runtime.log.mock.calls,
      runtime.error.mock.calls,
      vi.mocked(prompter.note).mock.calls,
    ]),
  };
}

async function expectDurableCustomCredential(setup: Awaited<ReturnType<typeof runCustomSetup>>) {
  const provider = "fixture-custom-2";
  const selectedProfileId = Object.keys(setup.config.auth?.profiles ?? {}).find((id) =>
    id.startsWith(provider + ":setup-"),
  );
  if (!selectedProfileId) {
    throw new Error("The verified credential was not persisted");
  }
  expect(setup.config.auth?.order?.[provider]).toEqual([selectedProfileId]);
  const { prepareAgentRuntimeAuth } = await import("../agents/runtime-plan/prepare-auth.js");
  const providerConfig = setup.config.models?.providers?.[provider];
  const prepared = prepareAgentRuntimeAuth({
    provider,
    modelId: model,
    modelApi: providerConfig?.api,
    modelBaseUrl: providerConfig?.baseUrl,
    config: setup.config,
    env: {},
    harnessId: "openclaw",
    authProfileStore: {
      version: 1,
      profiles: {
        [selectedProfileId]: { type: "api_key", provider, key: setup.credential },
        "later:host-account": { type: "api_key", provider, key: "ambient-host-key" },
      },
    },
  });
  expect(prepared.attempts.map(({ kind, profileId }) => ({ kind, profileId }))).toEqual([
    { kind: "profile", profileId: selectedProfileId },
  ]);
}

describe("guided custom provider activation", () => {
  it.each(["order-only", "store-only"] as const)(
    "preserves namespaces backed by %s authentication and binds subsequent requests",
    { timeout: 300_000 },
    async (authMetadata) => {
      const setup = await runCustomSetup({ protocol: "openai", surface: "gateway", authMetadata });
      expect(setup.result).toEqual(
        expect.arrayContaining(["Inference verified: fixture-custom-2/fixture-model"]),
      );
      expect(setup.config.auth?.order?.["fixture-custom"]).toEqual(
        setup.initialConfig.auth?.order?.["fixture-custom"],
      );
      expect(setup.requests.every((request) => request.authorized)).toBe(true);
      await expectDurableCustomCredential(setup);
    },
  );
  it.each<Scenario>([
    { protocol: "openai" as const },
    { protocol: "openai-responses" as const, secretRef: true },
    { protocol: "anthropic" as const },
    { protocol: "openai" as const, authless: true },
  ])(
    "verifies and persists $protocol with its selected credential shape",
    { timeout: 300_000 },
    async (scenario) => {
      const setup = await runCustomSetup(scenario);
      expect(setup.result).toEqual(
        expect.arrayContaining(["Inference verified: fixture-custom/fixture-model"]),
      );
      expect(setup.requests).toEqual([
        expect.objectContaining({ stream: false, authorized: true }),
        expect.objectContaining({ stream: true, authorized: true }),
      ]);
      expect(setup.config.models?.providers?.["fixture-custom"]?.apiKey).toEqual(
        scenario.authless
          ? undefined
          : scenario.secretRef
            ? { source: "env", provider: "default", id: "CUSTOM_SETUP_FIXTURE_KEY" }
            : setup.credential,
      );
      expect(setup.config.agents?.defaults?.model).toContain("fixture-custom/fixture-model");
      expect(setup.config.agents?.defaults?.models?.["fixture-custom/fixture-model"]?.alias).toBe(
        "fixture-alias",
      );
      expect(setup.config.models?.providers?.prior).toEqual(
        setup.initialConfig.models?.providers?.prior,
      );
      expect(setup.output).not.toContain(setup.credential);
    },
  );

  it.each(["fail", "cancel"] as const)(
    "preserves the prior route after completion %s",
    { timeout: 300_000 },
    async (outcome) => {
      const setup = await runCustomSetup({ protocol: "openai", outcome });
      expect(setup.requests).toHaveLength(2);
      expect(setup.result).toBeNull();
      expect(setup.config).toEqual(setup.initialConfig);
      expect(setup.output).not.toContain(setup.credential);
      expect(setup.activationResults).toEqual([
        expect.objectContaining({ ok: false, status: outcome === "fail" ? "auth" : "unavailable" }),
      ]);
    },
  );

  it("preserves the prior route when custom prompts are cancelled after endpoint verification", async () => {
    const setup = await runCustomSetup({ protocol: "openai", outcome: "prompt-cancel" });
    expect(setup.requests).toEqual([expect.objectContaining({ stream: false, authorized: true })]);
    expect(setup.cancelled).toBe(true);
    expect(setup.config).toEqual(setup.initialConfig);
  });

  it.each<Scenario["protocol"]>(["openai", "openai-responses", "anthropic"])(
    "verifies connected %s setup with the entered credential, not an ambient account",
    { timeout: 300_000 },
    async (protocol) => {
      const setup = await runCustomSetup({ protocol, surface: "gateway" });
      expect(setup.result).toEqual(
        expect.arrayContaining(["Inference verified: fixture-custom-2/fixture-model"]),
      );
      expect(setup.requests).toEqual([
        expect.objectContaining({ stream: false, authorized: true }),
        expect.objectContaining({ stream: true, authorized: true }),
      ]);
      expect(setup.textPrompts.some(([prompt]) => prompt.sensitive)).toBe(true);
      expect(setup.config.models?.providers?.["fixture-custom-2"]?.apiKey).toBeUndefined();
      expect(setup.config.agents?.defaults?.model).toContain("fixture-custom-2/fixture-model");
      await expectDurableCustomCredential(setup);
      expect(setup.output).not.toContain(setup.credential);
      expect(setup.output).not.toContain("ambient-host-key");
    },
  );

  it.each(["fail", "cancel"] as const)(
    "does not promote connected custom credentials after %s",
    { timeout: 300_000 },
    async (outcome) => {
      const setup = await runCustomSetup({ protocol: "openai", surface: "gateway", outcome });
      expect(setup.result).toBeNull();
      expect(setup.config).toEqual(setup.initialConfig);
      expect(setup.requests).toEqual([
        { stream: false, pathname: "/v1/chat/completions", authorized: true },
        { stream: true, pathname: "/v1/chat/completions", authorized: true },
      ]);
      expect(setup.output).not.toContain(setup.credential);
      expect(setup.activationResults).toEqual([expect.objectContaining({ ok: false })]);
    },
  );
});

function writeCompletion(response: ServerResponse, protocol: Scenario["protocol"]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (protocol === "openai") {
    const chunk = {
      id: "fixture-response",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
    };
    response.end(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  if (protocol === "anthropic") {
    const events = [
      {
        type: "message_start",
        message: {
          id: "fixture-response",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    response.end(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    );
    return;
  }
  const item = {
    type: "message",
    id: "fixture-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "OK", annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      delta: "OK",
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "fixture-response",
        status: "completed",
        model,
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}
