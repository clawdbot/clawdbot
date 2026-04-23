import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type {
  ImageDescriptionRequest,
  ImagesDescriptionRequest,
  MediaUnderstandingProvider,
} from "../../plugin-sdk/media-understanding.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { minimaxUnderstandImage } from "../minimax-vlm.js";
import { createOpenClawCodingTools } from "../pi-tools.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { createUnsafeMountedSandbox } from "../test-helpers/unsafe-mounted-sandbox.js";
import { makeZeroUsageSnapshot } from "../usage.js";
import { __testing, createImageTool, resolveImageModelConfigForTool } from "./image-tool.js";

type CreateOpenClawCodingToolsArgs = Parameters<typeof createOpenClawCodingTools>[0];
type MockOpenClawToolsOptions = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  sandboxRoot?: string;
  sandboxFsBridge?: SandboxFsBridge;
  fsPolicy?: NonNullable<Parameters<typeof createImageTool>[0]>["fsPolicy"];
  modelHasVision?: boolean;
};

const piToolsHarness = vi.hoisted(() => ({
  createStubTool(name: string) {
    return {
      name,
      description: `${name} stub`,
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    };
  },
}));

const imageProviderHarness = vi.hoisted(() => {
  let providers = new Map<string, MediaUnderstandingProvider>();
  return {
    setProviders(next: MediaUnderstandingProvider[]) {
      providers = new Map(next.map((provider) => [provider.id.toLowerCase(), provider]));
    },
    reset() {
      providers = new Map();
    },
    buildProviderRegistry(overrides?: Record<string, MediaUnderstandingProvider>) {
      const registry = new Map(providers);
      for (const [id, provider] of Object.entries(overrides ?? {})) {
        registry.set(id.toLowerCase(), provider);
      }
      return registry;
    },
    getMediaUnderstandingProvider(
      id: string,
      registry: Map<string, MediaUnderstandingProvider>,
    ): MediaUnderstandingProvider | undefined {
      return registry.get(id.toLowerCase()) ?? providers.get(id.toLowerCase());
    },
  };
});

vi.mock("../bash-tools.js", async () => {
  const actual = await vi.importActual<typeof import("../bash-tools.js")>("../bash-tools.js");
  return {
    ...actual,
    createExecTool: vi.fn(() => piToolsHarness.createStubTool("exec")),
    createProcessTool: vi.fn(() => piToolsHarness.createStubTool("process")),
  };
});

vi.mock("../channel-tools.js", () => ({
  copyChannelAgentToolMeta: vi.fn((_from, to) => to),
  listChannelAgentTools: vi.fn(() => []),
}));

vi.mock("../apply-patch.js", () => ({
  createApplyPatchTool: vi.fn(() => piToolsHarness.createStubTool("apply_patch")),
}));

vi.mock("../pi-tools.before-tool-call.js", () => ({
  wrapToolWithBeforeToolCallHook: vi.fn((tool) => tool),
}));

vi.mock("../pi-tools.abort.js", () => ({
  wrapToolWithAbortSignal: vi.fn((tool) => tool),
}));

vi.mock("../auth-profiles.js", () => ({
  ensureAuthProfileStore: (agentDir?: string) => {
    if (!agentDir) {
      return { version: 1, profiles: {} };
    }
    const pathname = path.join(agentDir, "auth-profiles.json");
    try {
      return JSON.parse(fsSync.readFileSync(pathname, "utf8")) as {
        version?: number;
        profiles?: Record<string, { provider?: string }>;
      };
    } catch {
      return { version: 1, profiles: {} };
    }
  },
  hasAnyAuthProfileStoreSource: (agentDir?: string) => {
    if (!agentDir) {
      return false;
    }
    return fsSync.existsSync(path.join(agentDir, "auth-profiles.json"));
  },
  listProfilesForProvider: (
    store: { profiles?: Record<string, { provider?: string }> },
    provider: string,
  ) => Object.values(store.profiles ?? {}).filter((profile) => profile?.provider === provider),
}));

vi.mock("../model-auth.js", () => ({
  resolveEnvApiKey: (provider: string) => {
    const envVarByProvider: Record<string, string[]> = {
      anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
      minimax: ["MINIMAX_API_KEY", "MINIMAX_OAUTH_TOKEN"],
      "minimax-portal": ["MINIMAX_OAUTH_TOKEN"],
      moonshot: ["MOONSHOT_API_KEY"],
      openai: ["OPENAI_API_KEY"],
      openrouter: ["OPENROUTER_API_KEY"],
      zai: ["ZAI_API_KEY", "Z_AI_API_KEY"],
    };
    const envVar = (envVarByProvider[provider] ?? []).find((key) => {
      const value = process.env[key];
      return typeof value === "string" && value.length > 0;
    });
    return {
      apiKey: envVar ? process.env[envVar] : undefined,
      source: envVar ? "env" : undefined,
      envVar,
    };
  },
}));

vi.mock("../openclaw-tools.js", async () => {
  const { createImageTool } = await import("./image-tool.js");
  return {
    createOpenClawTools: vi.fn((options?: MockOpenClawToolsOptions) => {
      const imageTool = createImageTool({
        config: options?.config,
        agentDir: options?.agentDir,
        workspaceDir: options?.workspaceDir,
        sandbox:
          options?.sandboxRoot && options?.sandboxFsBridge
            ? {
                root: options.sandboxRoot,
                bridge: options.sandboxFsBridge,
              }
            : undefined,
        fsPolicy: options?.fsPolicy,
        modelHasVision: options?.modelHasVision,
      });
      return imageTool ? [imageTool] : [];
    }),
  };
});

async function writeAuthProfiles(agentDir: string, profiles: unknown) {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "auth-profiles.json"),
    `${JSON.stringify(profiles, null, 2)}\n`,
    "utf8",
  );
}

async function createOpenClawCodingToolsWithFreshModules(options?: CreateOpenClawCodingToolsArgs) {
  const defaultImageModels = new Map<string, string>([
    ["anthropic", "claude-opus-4-6"],
    ["minimax", "MiniMax-VL-01"],
    ["minimax-portal", "MiniMax-VL-01"],
    ["openai", "gpt-5.4-mini"],
    ["zai", "glm-4.6v"],
  ]);
  __testing.setProviderDepsForTest({
    buildProviderRegistry: (overrides?: Record<string, MediaUnderstandingProvider>) =>
      imageProviderHarness.buildProviderRegistry(overrides),
    getMediaUnderstandingProvider: (
      id: string,
      registry: Map<string, MediaUnderstandingProvider>,
    ) => imageProviderHarness.getMediaUnderstandingProvider(id, registry),
    describeImageWithModel: describeGenericImageWithModel,
    describeImagesWithModel: describeGenericImagesWithModel,
    resolveAutoMediaKeyProviders: ({ capability }) =>
      capability === "image" ? ["openai", "anthropic"] : [],
    resolveDefaultMediaModel: ({ providerId, capability }) =>
      capability === "image" ? defaultImageModels.get(providerId.toLowerCase()) : undefined,
  });
  return createOpenClawCodingTools(options);
}

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
const ONE_PIXEL_GIF_B64 = "R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=";
const ONE_PIXEL_JPEG_B64 = "QUJDRA==";

async function withTempWorkspacePng(
  cb: (args: { workspaceDir: string; imagePath: string }) => Promise<void>,
  options?: { parentDir?: string },
) {
  const parentDir = options?.parentDir ?? os.tmpdir();
  const workspaceParent = await fs.mkdtemp(path.join(parentDir, "openclaw-workspace-image-"));
  try {
    const workspaceDir = path.join(workspaceParent, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const imagePath = path.join(workspaceDir, "photo.png");
    await fs.writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
    await cb({ workspaceDir, imagePath });
  } finally {
    await fs.rm(workspaceParent, { recursive: true, force: true });
  }
}

function registerImageToolEnvReset(priorFetch: typeof global.fetch, keys: string[]) {
  beforeEach(() => {
    for (const key of keys) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });
}

function stubMinimaxOkFetch() {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({
      content: "ok",
      base_resp: { status_code: 0, status_msg: "" },
    }),
  });
  global.fetch = withFetchPreconnect(fetch);
  vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
  return fetch;
}

function stubMinimaxFetch(baseResp: { status_code: number; status_msg: string }, content = "ok") {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({
      content,
      base_resp: baseResp,
    }),
  });
  global.fetch = withFetchPreconnect(fetch);
  return fetch;
}

function stubOpenAiCompletionsOkFetch(text = "ok") {
  const fetch = vi.fn().mockImplementation(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            const chunks = [
              `data: ${JSON.stringify({
                id: "chatcmpl-moonshot-test",
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: "kimi-k2.5",
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: text },
                    finish_reason: null,
                  },
                ],
              })}\n\n`,
              `data: ${JSON.stringify({
                id: "chatcmpl-moonshot-test",
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: "kimi-k2.5",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              })}\n\n`,
              "data: [DONE]\n\n",
            ];
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
  );
  global.fetch = withFetchPreconnect(fetch);
  return fetch;
}

function createMinimaxImageConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "minimax/MiniMax-M2.7" },
        imageModel: { primary: "minimax/MiniMax-VL-01" },
      },
    },
    plugins: {
      entries: {
        minimax: { enabled: true },
      },
    },
  };
}

function createDefaultImageFallbackExpectation(primary: string) {
  return {
    primary,
    fallbacks: ["openai/gpt-5.4-mini", "anthropic/claude-opus-4-6"],
  };
}

const minimaxProvider = {
  id: "minimax",
  capabilities: ["image"],
  describeImage: async (params: ImageDescriptionRequest) => ({
    text: await minimaxUnderstandImage({
      apiKey: process.env.MINIMAX_API_KEY ?? "",
      prompt: params.prompt ?? "Describe the image.",
      imageDataUrl: `data:${params.mime ?? "image/jpeg"};base64,${params.buffer.toString("base64")}`,
    }),
    model: "MiniMax-VL-01",
  }),
  describeImages: async (params: ImagesDescriptionRequest) => {
    const parts: string[] = [];
    for (const [index, image] of params.images.entries()) {
      const text = await minimaxUnderstandImage({
        apiKey: process.env.MINIMAX_API_KEY ?? "",
        prompt:
          params.images.length > 1
            ? `${params.prompt ?? "Describe the image."}\n\nDescribe image ${index + 1} of ${params.images.length} independently.`
            : (params.prompt ?? "Describe the image."),
        imageDataUrl: `data:${image.mime ?? "image/jpeg"};base64,${image.buffer.toString("base64")}`,
      });
      parts.push(params.images.length > 1 ? `Image ${index + 1}:\n${text.trim()}` : text.trim());
    }
    return {
      text: parts.join("\n\n").trim(),
      model: "MiniMax-VL-01",
    };
  },
} satisfies MediaUnderstandingProvider;

async function describeMoonshotImage(
  params: ImageDescriptionRequest,
): Promise<{ text: string; model: string }> {
  const baseUrl =
    params.cfg.models?.providers?.moonshot?.baseUrl?.trim() ?? "https://api.moonshot.ai/v1";
  await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.MOONSHOT_API_KEY ?? ""}`,
    },
    body: JSON.stringify({
      model: params.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: params.prompt ?? "Describe the image." },
            {
              type: "image_url",
              image_url: {
                url: `data:${params.mime ?? "image/jpeg"};base64,${params.buffer.toString("base64")}`,
              },
            },
          ],
        },
      ],
    }),
  });
  return { text: "ok moonshot", model: params.model };
}

async function describeMoonshotImages(
  params: ImagesDescriptionRequest,
): Promise<{ text: string; model: string }> {
  const [first] = params.images;
  if (!first) {
    return { text: "", model: params.model };
  }
  return await describeMoonshotImage({
    ...params,
    buffer: first.buffer,
    fileName: first.fileName,
    mime: first.mime,
  });
}

async function readMockResponseText(response: Response): Promise<string> {
  const contentType =
    response.headers instanceof Headers ? (response.headers.get("content-type") ?? "") : "";
  if (contentType.includes("application/json") || typeof response.text !== "function") {
    const payload = (await response.json()) as { content?: string };
    return payload.content ?? "";
  }
  const raw = await response.text();
  const match = raw.match(/"content":"([^"]*)"/);
  return match?.[1] ?? "";
}

async function describeGenericImageWithModel(
  params: ImageDescriptionRequest,
): Promise<{ text: string; model: string }> {
  const response = await global.fetch("https://example.invalid/media-image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: params.provider,
      model: params.model,
      prompt: params.prompt,
      mime: params.mime,
    }),
  });
  return { text: await readMockResponseText(response), model: params.model };
}

async function describeGenericImagesWithModel(
  params: ImagesDescriptionRequest,
): Promise<{ text: string; model: string }> {
  const response = await global.fetch("https://example.invalid/media-images", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: params.provider,
      model: params.model,
      prompt: params.prompt,
      imageCount: params.images.length,
    }),
  });
  return { text: await readMockResponseText(response), model: params.model };
}

const moonshotProvider = {
  id: "moonshot",
  capabilities: ["image"],
  describeImage: describeMoonshotImage,
  describeImages: describeMoonshotImages,
} satisfies MediaUnderstandingProvider;

function installImageUnderstandingProviderStubs(...providers: MediaUnderstandingProvider[]) {
  imageProviderHarness.setProviders(providers);
  const defaultImageModels = new Map<string, string>([
    ["anthropic", "claude-opus-4-6"],
    ["minimax", "MiniMax-VL-01"],
    ["minimax-portal", "MiniMax-VL-01"],
    ["openai", "gpt-5.4-mini"],
    ["zai", "glm-4.6v"],
  ]);
  __testing.setProviderDepsForTest({
    buildProviderRegistry: (overrides?: Record<string, MediaUnderstandingProvider>) =>
      imageProviderHarness.buildProviderRegistry(overrides),
    getMediaUnderstandingProvider: (
      id: string,
      registry: Map<string, MediaUnderstandingProvider>,
    ) => imageProviderHarness.getMediaUnderstandingProvider(id, registry),
    describeImageWithModel: describeGenericImageWithModel,
    describeImagesWithModel: describeGenericImagesWithModel,
    resolveAutoMediaKeyProviders: ({ capability }) =>
      capability === "image" ? ["openai", "anthropic"] : [],
    resolveDefaultMediaModel: ({ providerId, capability }) =>
      capability === "image" ? defaultImageModels.get(providerId.toLowerCase()) : undefined,
  });
}

function makeModelDefinition(id: string, input: Array<"text" | "image">): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

async function expectImageToolExecOk(
  tool: {
    execute: (toolCallId: string, input: { prompt: string; image: string }) => Promise<unknown>;
  },
  image: string,
) {
  await expect(
    tool.execute("t1", {
      prompt: "Describe the image.",
      image,
    }),
  ).resolves.toMatchObject({
    content: [{ type: "text", text: "ok" }],
  });
}

function requireImageTool<T>(tool: T | null | undefined): T {
  expect(tool).not.toBeNull();
  if (!tool) {
    throw new Error("expected image tool");
  }
  return tool;
}

function createRequiredImageTool(args: Parameters<typeof createImageTool>[0]) {
  return requireImageTool(createImageTool(args));
}

type ImageToolInstance = ReturnType<typeof createRequiredImageTool>;

async function withTempSandboxState(
  run: (ctx: { stateDir: string; agentDir: string; sandboxRoot: string }) => Promise<void>,
) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-sandbox-"));
  const agentDir = path.join(stateDir, "agent");
  const sandboxRoot = path.join(stateDir, "sandbox");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(sandboxRoot, { recursive: true });
  try {
    await run({ stateDir, agentDir, sandboxRoot });
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function withMinimaxImageToolFromTempAgentDir(
  run: (tool: ImageToolInstance) => Promise<void>,
) {
  await withTempAgentDir(async (agentDir) => {
    const cfg = createMinimaxImageConfig();
    await run(createRequiredImageTool({ config: cfg, agentDir }));
  });
}

function findSchemaUnionKeywords(schema: unknown, path = "root"): string[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) => findSchemaUnionKeywords(item, `${path}[${index}]`));
  }
  const record = schema as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    const nextPath = `${path}.${key}`;
    if (key === "anyOf" || key === "oneOf" || key === "allOf") {
      out.push(nextPath);
    }
    out.push(...findSchemaUnionKeywords(value, nextPath));
  }
  return out;
}

describe("image tool implicit imageModel config", () => {
  const priorFetch = global.fetch;
  registerImageToolEnvReset(priorFetch, [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "MINIMAX_API_KEY",
    "MODELSTUDIO_API_KEY",
    "QWEN_API_KEY",
    "DASHSCOPE_API_KEY",
    "ZAI_API_KEY",
    "Z_AI_API_KEY",
    // Avoid implicit Copilot provider discovery hitting the network in tests.
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ]);

  beforeEach(() => {
    installImageUnderstandingProviderStubs(minimaxProvider, moonshotProvider);
  });

  afterEach(() => {
    imageProviderHarness.reset();
    __testing.setProviderDepsForTest();
  });

  it("stays disabled without auth when no pairing is possible", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
      };
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toBeNull();
      expect(createImageTool({ config: cfg, agentDir })).toBeNull();
    });
  });

  it("pairs minimax primary with MiniMax-VL-01 (and fallbacks) when auth exists", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
      vi.stubEnv("MINIMAX_OAUTH_TOKEN", "minimax-oauth-test");
      vi.stubEnv("OPENAI_API_KEY", "openai-test");
      vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "minimax/MiniMax-M2.7" } } },
      };
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        ...createDefaultImageFallbackExpectation("minimax/MiniMax-VL-01"),
        fallbacks: ["openai/gpt-5.4-mini", "anthropic/claude-opus-4-6"],
      });
      expect(createImageTool({ config: cfg, agentDir })).not.toBeNull();
    });
  });

  it("pairs minimax-portal primary with MiniMax-VL-01 (and fallbacks) when auth exists", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeAuthProfiles(agentDir, {
        version: 1,
        profiles: {
          "minimax-portal:default": {
            type: "oauth",
            provider: "minimax-portal",
            access: "oauth-test",
            refresh: "refresh-test",
            expires: Date.now() + 60_000,
          },
        },
      });
      vi.stubEnv("OPENAI_API_KEY", "openai-test");
      vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "minimax-portal/MiniMax-M2.7" } } },
      };
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual(
        createDefaultImageFallbackExpectation("minimax-portal/MiniMax-VL-01"),
      );
      expect(createImageTool({ config: cfg, agentDir })).not.toBeNull();
    });
  });

  it("pairs zai primary with glm-4.6v (and fallbacks) when auth exists", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("ZAI_API_KEY", "zai-test");
      vi.stubEnv("OPENAI_API_KEY", "openai-test");
      vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
      };
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual(
        createDefaultImageFallbackExpectation("zai/glm-4.6v"),
      );
      expect(createImageTool({ config: cfg, agentDir })).not.toBeNull();
    });
  });

  it("pairs a custom provider when it declares an image-capable model", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeAuthProfiles(agentDir, {
        version: 1,
        profiles: {
          "acme:default": { type: "api_key", provider: "acme", key: "sk-test" },
        },
      });
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "acme/text-1" } } },
        models: {
          providers: {
            acme: {
              baseUrl: "https://example.com",
              models: [
                makeModelDefinition("text-1", ["text"]),
                makeModelDefinition("vision-1", ["text", "image"]),
              ],
            },
          },
        },
      };
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "acme/vision-1",
      });
      expect(createImageTool({ config: cfg, agentDir })).not.toBeNull();
    });
  });

  it("does not double-prefix custom provider model IDs that already include the provider", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeAuthProfiles(agentDir, {
        version: 1,
        profiles: {
          "kimchi:default": { type: "api_key", provider: "kimchi", key: "sk-test" },
        },
      });
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "kimchi/text-1" } } },
        models: {
          providers: {
            kimchi: {
              baseUrl: "https://example.com",
              models: [
                makeModelDefinition("kimchi/text-1", ["text"]),
                makeModelDefinition("kimchi/vision-1", ["text", "image"]),
              ],
            },
          },
        },
      };

      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "kimchi/vision-1",
      });
    });
  });

  it("pairs a provider when config uses an alias key", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeAuthProfiles(agentDir, {
        version: 1,
        profiles: {
          "amazon-bedrock:default": {
            type: "api_key",
            provider: "amazon-bedrock",
            key: "sk-test",
          },
        },
      });
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "aws-bedrock/text-1" } } },
        models: {
          providers: {
            "amazon-bedrock": {
              baseUrl: "https://example.com",
              models: [
                makeModelDefinition("text-1", ["text"]),
                makeModelDefinition("vision-1", ["text", "image"]),
              ],
            },
          },
        },
      };
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "amazon-bedrock/vision-1",
      });
      expect(createImageTool({ config: cfg, agentDir })).not.toBeNull();
    });
  });

  it("prefers explicit agents.defaults.imageModel", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "minimax/MiniMax-M2.7" },
            imageModel: { primary: "openai/gpt-5.4-mini" },
          },
        },
      };
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "openai/gpt-5.4-mini",
      });
    });
  });

  it("keeps image tool available when primary model supports images (for explicit requests)", async () => {
    // When the primary model supports images, we still keep the tool available
    // because images are auto-injected into prompts. The tool description is
    // adjusted via modelHasVision to discourage redundant usage.
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "acme/vision-1" },
            imageModel: { primary: "openai/gpt-5.4-mini" },
          },
        },
        models: {
          providers: {
            acme: {
              baseUrl: "https://example.com",
              models: [makeModelDefinition("vision-1", ["text", "image"])],
            },
          },
        },
      };
      // Tool should still be available for explicit image analysis requests
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "openai/gpt-5.4-mini",
      });
      const tool = createImageTool({ config: cfg, agentDir, modelHasVision: true });
      expect(tool).not.toBeNull();
      expect(tool?.description).toContain(
        "Only use this tool when images were NOT already provided",
      );
    });
  });

  it("sends moonshot image requests with user+image payloads only", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("MOONSHOT_API_KEY", "moonshot-test");
      const fetch = stubOpenAiCompletionsOkFetch("ok moonshot");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "moonshot/kimi-k2.5" },
            imageModel: { primary: "moonshot/kimi-k2.5" },
          },
        },
        models: {
          providers: {
            moonshot: {
              api: "openai-completions",
              baseUrl: "https://api.moonshot.ai/v1",
              models: [makeModelDefinition("kimi-k2.5", ["text", "image"])],
            },
          },
        },
      };

      const tool = requireImageTool(createImageTool({ config: cfg, agentDir }));
      const result = await tool.execute("t1", {
        prompt: "Describe this image in one word.",
        image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      });

      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0] as [unknown, { body?: unknown }];
      expect(String(url)).toBe("https://api.moonshot.ai/v1/chat/completions");
      expect(typeof init?.body).toBe("string");
      const bodyRaw = typeof init?.body === "string" ? init.body : "";
      const payload = JSON.parse(bodyRaw) as {
        messages?: Array<{
          role?: string;
          content?: Array<{
            type?: string;
            text?: string;
            image_url?: { url?: string };
          }>;
        }>;
      };

      expect(payload.messages?.map((message) => message.role)).toEqual(["user"]);
      const userContent = payload.messages?.[0]?.content ?? [];
      expect(userContent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: "Describe this image in one word.",
          }),
          expect.objectContaining({ type: "image_url" }),
        ]),
      );
      expect(userContent.find((block) => block.type === "image_url")?.image_url?.url).toContain(
        "data:image/png;base64,",
      );
      expect(bodyRaw).not.toContain('"role":"developer"');
      expect(result.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "text", text: "ok moonshot" })]),
      );
    });
  });

  it("falls back to the generic image runtime when openrouter has no media provider registration", async () => {
    await withTempAgentDir(async (agentDir) => {
      const fetch = stubOpenAiCompletionsOkFetch("ok openrouter");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openrouter/google/gemini-2.5-flash-lite" },
            imageModel: { primary: "openrouter/google/gemini-2.5-flash-lite" },
          },
        },
        models: {
          providers: {
            openrouter: {
              api: "openai-completions",
              baseUrl: "https://openrouter.ai/api/v1",
              apiKey: "openrouter-test",
              models: [makeModelDefinition("google/gemini-2.5-flash-lite", ["text", "image"])],
            },
          },
        },
      };

      const tool = requireImageTool(createImageTool({ config: cfg, agentDir }));
      const result = await tool.execute("t1", {
        prompt: "Describe the image.",
        image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      });

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "text", text: "ok openrouter" })]),
      );
    });
  });

  it("falls back to the generic multi-image runtime when openrouter has no media provider registration", async () => {
    await withTempAgentDir(async (agentDir) => {
      const fetch = stubOpenAiCompletionsOkFetch("ok multi");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openrouter/google/gemini-2.5-flash-lite" },
            imageModel: { primary: "openrouter/google/gemini-2.5-flash-lite" },
          },
        },
        models: {
          providers: {
            openrouter: {
              api: "openai-completions",
              baseUrl: "https://openrouter.ai/api/v1",
              apiKey: "openrouter-test",
              models: [makeModelDefinition("google/gemini-2.5-flash-lite", ["text", "image"])],
            },
          },
        },
      };

      const tool = requireImageTool(createImageTool({ config: cfg, agentDir }));
      const result = await tool.execute("t1", {
        prompt: "Describe the images.",
        images: [
          `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
          `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
        ],
      });

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "text", text: "ok multi" })]),
      );
    });
  });

  it("falls back to the generic image runtime when minimax-portal has no media provider registration", async () => {
    await withTempAgentDir(async (agentDir) => {
      installImageUnderstandingProviderStubs();
      await writeAuthProfiles(agentDir, {
        version: 1,
        profiles: {
          "minimax-portal:default": {
            type: "oauth",
            provider: "minimax-portal",
            access: "oauth-test",
            refresh: "refresh-test",
            expires: Date.now() + 60_000,
          },
        },
      });
      const fetch = stubMinimaxOkFetch();
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "minimax-portal/MiniMax-M2.7" },
            imageModel: { primary: "minimax-portal/MiniMax-VL-01" },
          },
        },
      };

      const tool = requireImageTool(createImageTool({ config: cfg, agentDir }));
      await expectImageToolExecOk(tool, `data:image/png;base64,${ONE_PIXEL_PNG_B64}`);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  it("exposes an Anthropic-safe image schema without union keywords", async () => {
    await withMinimaxImageToolFromTempAgentDir(async (tool) => {
      const violations = findSchemaUnionKeywords(tool.parameters, "image.parameters");
      expect(violations).toEqual([]);

      const schema = tool.parameters as {
        properties?: Record<string, unknown>;
      };
      const imageSchema = schema.properties?.image as { type?: unknown } | undefined;
      const imagesSchema = schema.properties?.images as
        | { type?: unknown; items?: unknown }
        | undefined;
      const imageItems = imagesSchema?.items as { type?: unknown } | undefined;

      expect(imageSchema?.type).toBe("string");
      expect(imagesSchema?.type).toBe("array");
      expect(imageItems?.type).toBe("string");
    });
  });

  it("keeps an Anthropic-safe image schema snapshot", async () => {
    await withMinimaxImageToolFromTempAgentDir(async (tool) => {
      expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual({
        type: "object",
        properties: {
          prompt: { type: "string" },
          image: { description: "Single image path or URL.", type: "string" },
          images: {
            description: "Multiple image paths or URLs (up to maxImages, default 20).",
            type: "array",
            items: { type: "string" },
          },
          model: { type: "string" },
          maxBytesMb: { type: "number" },
          maxImages: { type: "number" },
        },
      });
    });
  });

  it("still rejects temp workspace paths outside allowed local roots when workspaceOnly is off", async () => {
    await withTempWorkspacePng(async ({ workspaceDir, imagePath }) => {
      const fetch = stubMinimaxOkFetch();
      await withTempAgentDir(async (agentDir) => {
        const cfg = createMinimaxImageConfig();

        const withoutWorkspace = createRequiredImageTool({ config: cfg, agentDir });
        await expect(
          withoutWorkspace.execute("t1", { prompt: "Describe.", image: imagePath }),
        ).rejects.toThrow(/not under an allowed directory/i);

        const withWorkspace = createRequiredImageTool({ config: cfg, agentDir, workspaceDir });

        await expectImageToolExecOk(withWorkspace, imagePath);

        expect(fetch).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("respects fsPolicy.workspaceOnly for non-sandbox image paths", async () => {
    await withTempWorkspacePng(async ({ workspaceDir, imagePath }) => {
      const fetch = stubMinimaxOkFetch();
      await withTempAgentDir(async (agentDir) => {
        const cfg = createMinimaxImageConfig();

        const tool = createRequiredImageTool({
          config: cfg,
          agentDir,
          workspaceDir,
          fsPolicy: { workspaceOnly: true },
        });

        // File inside workspace is allowed.
        await expectImageToolExecOk(tool, imagePath);
        expect(fetch).toHaveBeenCalledTimes(1);

        // File outside workspace is rejected even without sandbox.
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-outside-"));
        const outsideImage = path.join(outsideDir, "secret.png");
        await fs.writeFile(outsideImage, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
        try {
          await expect(
            tool.execute("t2", { prompt: "Describe.", image: outsideImage }),
          ).rejects.toThrow(/not under an allowed directory/i);
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      });
    });
  });

  it("still rejects non-workspace local image paths when workspaceOnly is disabled", async () => {
    const fetch = stubMinimaxOkFetch();
    await withTempAgentDir(async (agentDir) => {
      const cfg = createMinimaxImageConfig();
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-outside-"));
      const outsideImage = path.join(outsideDir, "secret.png");
      await fs.writeFile(outsideImage, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
      try {
        const tool = createRequiredImageTool({
          config: cfg,
          agentDir,
          fsPolicy: { workspaceOnly: false },
        });

        await expect(
          tool.execute("t1", { prompt: "Describe.", image: outsideImage }),
        ).rejects.toThrow(/not under an allowed directory/i);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it("allows workspace images via createOpenClawCodingTools when workspace root is explicit", async () => {
    await withTempWorkspacePng(async ({ workspaceDir, imagePath }) => {
      const fetch = stubMinimaxOkFetch();
      await withTempAgentDir(async (agentDir) => {
        const cfg = createMinimaxImageConfig();

        const tools = await createOpenClawCodingToolsWithFreshModules({
          config: cfg,
          agentDir,
          workspaceDir,
        });
        const tool = requireImageTool(tools.find((candidate) => candidate.name === "image"));

        await expectImageToolExecOk(tool, imagePath);

        expect(fetch).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("resolves relative image paths against workspaceDir", async () => {
    await withTempWorkspacePng(async ({ workspaceDir }) => {
      // Place image in a subdirectory of the workspace
      const subdir = path.join(workspaceDir, "inbox");
      await fs.mkdir(subdir, { recursive: true });
      const imagePath = path.join(subdir, "receipt.png");
      await fs.writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));

      const fetch = stubMinimaxOkFetch();
      await withTempAgentDir(async (agentDir) => {
        const cfg = createMinimaxImageConfig();
        const tool = createRequiredImageTool({ config: cfg, agentDir, workspaceDir });

        // Relative path should be resolved against workspaceDir
        await expectImageToolExecOk(tool, "inbox/receipt.png");
        expect(fetch).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("sandboxes image paths like the read tool", async () => {
    await withTempSandboxState(async ({ agentDir, sandboxRoot }) => {
      await fs.writeFile(path.join(sandboxRoot, "img.png"), "fake", "utf8");
      const sandbox = { root: sandboxRoot, bridge: createHostSandboxFsBridge(sandboxRoot) };

      vi.stubEnv("OPENAI_API_KEY", "openai-test");
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "minimax/MiniMax-M2.7" } } },
      };
      const tool = createRequiredImageTool({ config: cfg, agentDir, sandbox });

      await expect(tool.execute("t1", { image: "https://example.com/a.png" })).rejects.toThrow(
        /Sandboxed image tool does not allow remote URLs/i,
      );

      await expect(tool.execute("t2", { image: "../escape.png" })).rejects.toThrow(
        /escapes sandbox root/i,
      );
    });
  });

  it("applies tools.fs.workspaceOnly to image paths in sandbox mode", async () => {
    await withTempSandboxState(async ({ agentDir, sandboxRoot }) => {
      await fs.writeFile(
        path.join(agentDir, "secret.png"),
        Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
      );
      const sandbox = createUnsafeMountedSandbox({ sandboxRoot, agentRoot: agentDir });
      const fetch = stubMinimaxOkFetch();
      const cfg: OpenClawConfig = {
        ...createMinimaxImageConfig(),
        tools: { fs: { workspaceOnly: true } },
      };

      const tools = await createOpenClawCodingToolsWithFreshModules({
        config: cfg,
        agentDir,
        sandbox,
        workspaceDir: sandboxRoot,
      });
      const readTool = tools.find((candidate) => candidate.name === "read");
      if (!readTool) {
        throw new Error("expected read tool");
      }
      const imageTool = requireImageTool(tools.find((candidate) => candidate.name === "image"));

      await expect(readTool.execute("t1", { path: "/agent/secret.png" })).rejects.toThrow(
        /Path escapes sandbox root/i,
      );
      await expect(
        imageTool.execute("t2", {
          prompt: "Describe the image.",
          image: "/agent/secret.png",
        }),
      ).rejects.toThrow(/Path escapes sandbox root/i);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it("rewrites inbound absolute paths into sandbox media/inbound", async () => {
    await withTempSandboxState(async ({ agentDir, sandboxRoot }) => {
      await fs.mkdir(path.join(sandboxRoot, "media", "inbound"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(sandboxRoot, "media", "inbound", "photo.png"),
        Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
      );

      const fetch = stubMinimaxOkFetch();

      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "minimax/MiniMax-M2.7" },
            imageModel: { primary: "minimax/MiniMax-VL-01" },
          },
        },
      };
      const sandbox = { root: sandboxRoot, bridge: createHostSandboxFsBridge(sandboxRoot) };
      const tool = createRequiredImageTool({ config: cfg, agentDir, sandbox });

      const res = await tool.execute("t1", {
        prompt: "Describe the image.",
        image: "@/Users/steipete/.openclaw/media/inbound/photo.png",
      });

      expect(fetch).toHaveBeenCalledTimes(1);
      expect((res.details as { rewrittenFrom?: string }).rewrittenFrom).toContain("photo.png");
    });
  });
});

describe("image tool data URL support", () => {
  it("decodes base64 image data URLs", () => {
    const pngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
    const out = __testing.decodeDataUrl(`data:image/png;base64,${pngB64}`);
    expect(out.kind).toBe("image");
    expect(out.mimeType).toBe("image/png");
    expect(out.buffer.length).toBeGreaterThan(0);
  });

  it("rejects non-image data URLs", () => {
    expect(() => __testing.decodeDataUrl("data:text/plain;base64,SGVsbG8=")).toThrow(
      /Unsupported data URL type/i,
    );
  });

  it("rejects oversized data URLs before decoding", () => {
    const oversizedBase64 = "A".repeat(16);
    const dataUrl = `data:image/png;base64,${oversizedBase64}`;
    const bufferFromSpy = vi.spyOn(Buffer, "from");

    try {
      expect(() => __testing.decodeDataUrl(dataUrl, { maxBytes: 4 })).toThrow(/size limit/i);
      expect(bufferFromSpy).not.toHaveBeenCalledWith(oversizedBase64, "base64");
    } finally {
      bufferFromSpy.mockRestore();
    }
  });
});

describe("image tool MiniMax VLM routing", () => {
  const pngB64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
  const priorFetch = global.fetch;
  registerImageToolEnvReset(priorFetch, [
    "MINIMAX_API_KEY",
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ]);

  beforeEach(() => {
    installImageUnderstandingProviderStubs(minimaxProvider);
  });

  afterEach(() => {
    imageProviderHarness.reset();
    __testing.setProviderDepsForTest();
  });

  async function createMinimaxVlmFixture(baseResp: { status_code: number; status_msg: string }) {
    const fetch = stubMinimaxFetch(baseResp, baseResp.status_code === 0 ? "ok" : "");

    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-minimax-vlm-"));
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
    const cfg = createMinimaxImageConfig();
    const tool = createRequiredImageTool({ config: cfg, agentDir });
    return { fetch, tool };
  }

  it("accepts image for single-image requests and calls /v1/coding_plan/vlm", async () => {
    const { fetch, tool } = await createMinimaxVlmFixture({ status_code: 0, status_msg: "" });

    const res = await tool.execute("t1", {
      prompt: "Describe the image.",
      image: `data:image/png;base64,${pngB64}`,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.minimax.io/v1/coding_plan/vlm");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer minimax-test");
    expect(String(init?.body)).toContain('"prompt":"Describe the image."');
    expect(String(init?.body)).toContain('"image_url":"data:image/png;base64,');

    const text = res.content?.find((b) => b.type === "text")?.text ?? "";
    expect(text).toBe("ok");
  });

  it("accepts images[] for multi-image requests", async () => {
    const { fetch, tool } = await createMinimaxVlmFixture({ status_code: 0, status_msg: "" });

    const res = await tool.execute("t1", {
      prompt: "Compare these images.",
      images: [`data:image/png;base64,${pngB64}`, `data:image/jpeg;base64,${ONE_PIXEL_JPEG_B64}`],
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const details = res.details as
      | {
          images?: Array<{ image: string }>;
        }
      | undefined;
    expect(details?.images).toHaveLength(2);
  });

  it("combines image + images with dedupe and enforces maxImages", async () => {
    const { fetch, tool } = await createMinimaxVlmFixture({ status_code: 0, status_msg: "" });

    const deduped = await tool.execute("t1", {
      prompt: "Compare these images.",
      image: `data:image/png;base64,${pngB64}`,
      images: [
        `data:image/png;base64,${pngB64}`,
        `data:image/jpeg;base64,${ONE_PIXEL_JPEG_B64}`,
        `data:image/jpeg;base64,${ONE_PIXEL_JPEG_B64}`,
      ],
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const dedupedDetails = deduped.details as
      | {
          images?: Array<{ image: string }>;
        }
      | undefined;
    expect(dedupedDetails?.images).toHaveLength(2);

    const tooMany = await tool.execute("t2", {
      prompt: "Compare these images.",
      image: `data:image/png;base64,${pngB64}`,
      images: [`data:image/gif;base64,${ONE_PIXEL_GIF_B64}`],
      maxImages: 1,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(tooMany.details).toMatchObject({
      error: "too_many_images",
      count: 2,
      max: 1,
    });
  });

  it("surfaces MiniMax API errors from /v1/coding_plan/vlm", async () => {
    const { tool } = await createMinimaxVlmFixture({ status_code: 1004, status_msg: "bad key" });

    await expect(
      tool.execute("t1", {
        prompt: "Describe the image.",
        image: `data:image/png;base64,${pngB64}`,
      }),
    ).rejects.toThrow(/MiniMax VLM API error/i);
  });
});

describe("image tool response validation", () => {
  function createAssistantMessage(
    overrides: Partial<{
      api: string;
      provider: string;
      model: string;
      stopReason: string;
      errorMessage: string;
      content: unknown[];
    }>,
  ) {
    return {
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4-mini",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: makeZeroUsageSnapshot(),
      content: [] as unknown[],
      ...overrides,
    };
  }

  it.each([
    {
      name: "caps image-tool max tokens by model capability",
      maxOutputTokens: 4000,
      expected: 4000,
    },
    {
      name: "keeps requested image-tool max tokens when model capability is higher",
      maxOutputTokens: 8192,
      expected: 4096,
    },
    {
      name: "falls back to requested image-tool max tokens when model capability is missing",
      maxOutputTokens: undefined,
      expected: 4096,
    },
  ])("$name", ({ maxOutputTokens, expected }) => {
    expect(__testing.resolveImageToolMaxTokens(maxOutputTokens)).toBe(expected);
  });

  it.each([
    {
      name: "rejects image-model responses with no final text",
      message: createAssistantMessage({
        content: [{ type: "thinking", thinking: "hmm" }],
      }) as never,
      expectedError: /returned no text/i,
    },
    {
      name: "surfaces provider errors from image-model responses",
      message: createAssistantMessage({
        stopReason: "error",
        errorMessage: "boom",
      }) as never,
      expectedError: /boom/i,
    },
  ])("$name", ({ message, expectedError }) => {
    expect(() =>
      __testing.coerceImageAssistantText({
        provider: "openai",
        model: "gpt-5.4-mini",
        message,
      }),
    ).toThrow(expectedError);
  });

  it("returns trimmed text from image-model responses", () => {
    const text = __testing.coerceImageAssistantText({
      provider: "anthropic",
      model: "claude-opus-4-6",
      message: {
        ...createAssistantMessage({
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-opus-4-6",
        }),
        content: [{ type: "text", text: "  hello  " }],
      } as never,
    });
    expect(text).toBe("hello");
  });

  it.each(["reasoning_content", "reasoning", "reasoning_details", "reasoning_text"])(
    "detects %s as a retryable image reasoning-only response",
    (thinkingSignature) => {
      const message = createAssistantMessage({
        content: [
          {
            type: "thinking",
            thinking: "  <think>private</think> maybe a cat  ",
            thinkingSignature,
          },
        ],
      });
      expect(__testing.hasImageReasoningOnlyResponse(message as never)).toBe(true);
      expect(() =>
        __testing.coerceImageAssistantText({
          provider: "openai",
          model: "gpt-5.4-mini",
          message: message as never,
        }),
      ).toThrow(/returned no text/i);
    },
  );

  it.each([
    JSON.stringify({ id: "rs_123", type: "reasoning" }),
    { id: "rs_456", type: "reasoning.encrypted" },
  ])(
    "detects Responses reasoning signature as a retryable image reasoning-only response",
    (thinkingSignature) => {
      const message = createAssistantMessage({
        content: [
          {
            type: "thinking",
            thinking: "  <think>private</think> maybe a cat  ",
            thinkingSignature,
          },
        ],
      });
      expect(__testing.hasImageReasoningOnlyResponse(message as never)).toBe(true);
      expect(() =>
        __testing.coerceImageAssistantText({
          provider: "openai",
          model: "gpt-5.4-mini",
          message: message as never,
        }),
      ).toThrow(/returned no text/i);
    },
  );

  it("detects oversized JSON reasoning signatures without parsing the whole payload", () => {
    const message = createAssistantMessage({
      content: [
        {
          type: "thinking",
          thinking: "retryable",
          thinkingSignature: JSON.stringify({
            id: "rs_123",
            summary: [{ text: "x".repeat(2_100) }],
            type: "reasoning",
          }),
        },
      ],
    });

    expect(__testing.hasImageReasoningOnlyResponse(message as never)).toBe(true);
  });

  it("ignores oversized JSON signatures without Responses reasoning markers", () => {
    const message = createAssistantMessage({
      content: [
        {
          type: "thinking",
          thinking: "retryable",
          thinkingSignature: `{"id":"not-reasoning","summary":"${"x".repeat(2_100)}"}`,
        },
      ],
    });

    expect(__testing.hasImageReasoningOnlyResponse(message as never)).toBe(false);
  });

  it("detects signed reasoning-only responses with empty summary text", () => {
    const message = createAssistantMessage({
      content: [
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: "reasoning_content",
        },
      ],
    });

    expect(__testing.hasImageReasoningOnlyResponse(message as never)).toBe(true);
  });

  it("bounds reasoning-only detection before scanning every block", () => {
    const message = createAssistantMessage({
      content: [
        ...Array.from({ length: 50 }, () => ({ type: "thinking", thinking: "untagged" })),
        {
          type: "thinking",
          thinking: "retryable",
          thinkingSignature: "reasoning_content",
        },
      ],
    });

    expect(__testing.hasImageReasoningOnlyResponse(message as never)).toBe(false);
  });
});
