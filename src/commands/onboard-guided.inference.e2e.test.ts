import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { listKnownProviderEnvApiKeyNames } from "../agents/model-auth-env-vars.js";
import { captureFullEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";

vi.mock("./onboard-interactive-runner.js", async (importActual) => {
  const actual = await importActual<typeof import("./onboard-interactive-runner.js")>();
  return {
    ...actual,
    hasInteractiveOnboardingTty: () => true,
    runInteractiveOnboarding: async (run: () => Promise<void>) => await run(),
  };
});

type MockOpenAiServer = {
  baseUrl: string;
  requestBodies: string[];
  close: () => Promise<void>;
};

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanupTasks.splice(0).map((cleanup) => cleanup()));
  vi.resetModules();
});

describe("guided onboarding inference composition", () => {
  it(
    "advances from full-access detection through a real embedded OpenAI probe",
    { timeout: 300_000 },
    async () => {
      const env = captureFullEnv();
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-guided-inference-e2e-"));
      const workspace = path.join(root, "workspace");
      const configPath = path.join(root, "openclaw.json");
      const mockOpenAi = await startMockOpenAiServer();
      cleanupTasks.push(async () => {
        env.restore();
        await mockOpenAi.close();
        await fs.rm(root, { recursive: true, force: true });
      });

      for (const key of listKnownProviderEnvApiKeyNames()) {
        deleteTestEnvValue(key);
      }
      setTestEnvValue("HOME", root);
      setTestEnvValue("USERPROFILE", root);
      setTestEnvValue("CODEX_HOME", path.join(root, "codex"));
      setTestEnvValue("CLAUDE_CONFIG_DIR", path.join(root, "claude"));
      setTestEnvValue("OPENCLAW_STATE_DIR", root);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      setTestEnvValue("OPENAI_API_KEY", "test-openai-key");
      setTestEnvValue("PATH", path.dirname(process.execPath));

      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({
          gateway: { mode: "local" },
          plugins: { slots: { memory: "none" } },
          agents: {
            defaults: {
              workspace,
              skipBootstrap: true,
              skills: [],
              models: { "openai/gpt-5.6": { agentRuntime: { id: "openclaw" } } },
            },
          },
          models: {
            mode: "replace",
            providers: {
              openai: {
                baseUrl: `${mockOpenAi.baseUrl}/v1`,
                apiKey: "OPENAI_API_KEY",
                api: "openai-responses",
                request: { allowPrivateNetwork: true },
                models: [
                  {
                    id: "gpt-5.6",
                    name: "GPT-5.6 mock",
                    api: "openai-responses",
                    reasoning: true,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 272_000,
                    maxTokens: 128_000,
                  },
                ],
              },
            },
          },
        })}\n`,
      );

      const prompter = createWizardPrompter(undefined, { selectValues: ["full", "use"] });
      const runSetupMemoryImportStep = vi.fn(async () => ({
        status: "skipped" as const,
        providers: [],
      }));
      const runAppRecommendations = vi.fn(async ({ config }) => ({
        config,
        commitResult: vi.fn(),
      }));
      const launchHatchTui = vi.fn(async () => undefined);
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn((code: number): never => {
          throw new Error(`unexpected exit ${code}`);
        }),
      };

      const configModule = await import("../config/config.js");
      configModule.clearConfigCache();
      const setupInference = await import("../system-agent/setup-inference.js");
      const onboardInference = await import("./onboard-inference.js");
      const { runGuidedOnboarding } = await import("./onboard-guided.js");
      await runGuidedOnboarding({ acceptRisk: true, workspace, tui: true }, runtime, {
        createPrompter: () => prompter,
        detect: async () => {
          const probeLocalCommand = async (command: string) => ({
            command,
            found: false,
            error: "not found",
          });
          const result = await setupInference.detectSetupInference({
            detectInferenceBackends: async (options) =>
              await onboardInference.detectInferenceBackends({
                config: options?.config,
                env: process.env,
                platform: "linux",
                deps: {
                  probeLocalCommand,
                  readClaudeCliCredentials: () => null,
                  readCodexCliCredentials: () => null,
                  readGeminiCliCredentials: () => null,
                  randomInt: () => 0,
                },
              }),
            probeLocalCommand,
            resolveManifestProviderAuthChoices: () => [],
          });
          return result;
        },
        activate: setupInference.activateSetupInference,
        runSetupMemoryImportStep,
        runAppRecommendations,
        launchHatchTui,
      });

      expect(prompter.select).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          options: expect.arrayContaining([expect.objectContaining({ value: "full" })]),
        }),
      );
      expect(mockOpenAi.requestBodies).toHaveLength(1);
      expect(JSON.parse(mockOpenAi.requestBodies[0] ?? "{}")).toMatchObject({ model: "gpt-5.6" });
      const notes = (prompter.note as ReturnType<typeof vi.fn>).mock.calls;
      const inferenceReadyIndex = notes.findIndex((call) => call[1] === "Inference ready");
      const postInferenceIndex = notes.findIndex(
        (call, index) =>
          index > inferenceReadyIndex &&
          String(call[0]).includes("your AI just passed a fresh check"),
      );
      expect(inferenceReadyIndex).toBeGreaterThanOrEqual(0);
      expect(postInferenceIndex).toBeGreaterThan(inferenceReadyIndex);
      expect(runSetupMemoryImportStep).toHaveBeenCalledOnce();
      expect(runAppRecommendations).toHaveBeenCalledWith(
        expect.objectContaining({ modelRouteVerified: true, workspaceDir: workspace }),
      );
      expect(launchHatchTui).toHaveBeenCalledWith(workspace);
    },
  );
});

async function startMockOpenAiServer(): Promise<MockOpenAiServer> {
  const requestBodies: string[] = [];
  const server = createServer((request, response) => {
    void handleMockOpenAiRequest(request, response, requestBodies);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock OpenAI server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestBodies,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

async function handleMockOpenAiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestBodies: string[],
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method !== "POST" || url.pathname !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  requestBodies.push(body);
  writeMockOpenAiResponse(response);
}

function writeMockOpenAiResponse(response: ServerResponse): void {
  const text = "OK";
  const message = {
    type: "message",
    id: "guided-inference-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: "guided-inference-response",
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}
