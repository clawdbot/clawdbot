// Shared PDF tool test helpers provide isolated agent dirs and scrub provider
// auth variables for deterministic model-resolution tests.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Mock, vi } from "vitest";
import * as webMedia from "../../media/web-media.js";
import * as modelAuth from "../model-auth.js";
import * as modelsConfig from "../models-config.js";
import * as preparedModelRuntime from "../prepared-model-runtime.js";
import {
  getModelRegistryRuntime,
  initializeModelRegistryRuntime,
} from "../sessions/model-registry-runtime.js";

export async function withTempPdfAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pdf-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

export function resetPdfToolAuthEnv(): void {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("GOOGLE_API_KEY", "");
  vi.stubEnv("MINIMAX_API_KEY", "");
  vi.stubEnv("ZAI_API_KEY", "");
  vi.stubEnv("Z_AI_API_KEY", "");
  vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
}

export const FAKE_PDF_MEDIA = {
  kind: "document",
  buffer: Buffer.from("%PDF-1.4 fake"),
  contentType: "application/pdf",
  fileName: "doc.pdf",
} as const;

// The PDF tool suites share this module-boundary stub.  It is built through a
// factory rather than exported directly because it wires the suite's own
// `complete` mock into the model registry, and vi.mock handles are file-scoped
// — a plain export would capture the wrong (or no) mock.
export function createPdfToolInfraStub(completeMock: Mock) {
  function createPdfModelRegistry(find: () => unknown) {
    const modelRegistry = { find };
    initializeModelRegistryRuntime(modelRegistry);
    getModelRegistryRuntime(modelRegistry).llmRuntime.complete = completeMock;
    return modelRegistry;
  }

  async function stubPdfToolInfra(
    agentDir: string,
    params?: {
      mockLoad?: boolean;
      provider?: string;
      input?: string[];
      api?: string;
      modelFound?: boolean;
    },
  ) {
    // Keep PDF tool tests focused on orchestration; provider discovery, auth, and
    // remote media loading are replaced with narrow spies at the module boundary.
    const loadSpy = vi.spyOn(webMedia, "loadWebMediaRaw");
    if (params?.mockLoad !== false) {
      loadSpy.mockResolvedValue(FAKE_PDF_MEDIA as never);
    }

    const setRuntimeApiKey = vi.fn();
    const authStorage = { setRuntimeApiKey };
    const find =
      params?.modelFound === false
        ? () => null
        : () =>
            ({
              provider: params?.provider ?? "anthropic",
              api:
                params?.api ??
                (params?.provider === "openai"
                  ? "openai-chatgpt-responses"
                  : params?.provider === "openai"
                    ? "openai-responses"
                    : "anthropic-messages"),
              maxTokens: 8192,
              input: params?.input ?? ["text", "document"],
            }) as never;
    const modelRegistry = createPdfModelRegistry(find);
    const release = vi.fn();
    vi.spyOn(preparedModelRuntime, "acquireAgentRunPreparedModelRuntime").mockImplementation(
      async (input) =>
        ({
          snapshot: {
            agentDir: input.agentDir,
            config: input.config,
            workspaceDir: input.workspaceDir,
            createStores: () => ({ authStorage, modelRegistry }),
          },
          release,
        }) as never,
    );

    vi.spyOn(modelsConfig, "ensureOpenClawModelsJson").mockResolvedValue({
      agentDir,
      wrote: false,
    });

    vi.spyOn(modelAuth, "getApiKeyForModel").mockResolvedValue({ apiKey: "test-key" } as never);
    vi.spyOn(modelAuth, "requireApiKey").mockReturnValue("test-key");

    return { loadSpy, release, setRuntimeApiKey };
  }

  return { createPdfModelRegistry, stubPdfToolInfra };
}
