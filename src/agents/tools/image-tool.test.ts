// Image tool tests cover model routing, provider auth, path safety, inbound
// media refs, data URLs, response validation, and compression policy.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isInboundPathAllowed } from "@openclaw/media-core/inbound-path-policy";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import { encodePngRgba, fillPixel } from "../../media/png-encode.js";
import type {
  ImageDescriptionRequest,
  ImagesDescriptionRequest,
  MediaUnderstandingProvider,
} from "../../plugin-sdk/media-understanding.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import type { AuthProfileCredential, AuthProfileStore } from "../auth-profiles/types.js";
import { minimaxUnderstandImage } from "../minimax-vlm.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { createUnsafeMountedSandbox } from "../test-helpers/unsafe-mounted-sandbox.js";
import { makeZeroUsageSnapshot } from "../usage.js";
import { createImageTool } from "./image-tool.js";
import { testing, resolveImageModelConfigForTool } from "./image-tool.test-support.js";
import { resolveMediaToolInboundRoots } from "./media-tool-shared.js";

function jsonRoundTrip<T>(value: T): T {
  // Anthropic rejects union-heavy schemas, so schema snapshots must survive the
  // same JSON serialization path used for model-facing tool definitions.
  const serialized = JSON.stringify(value);
  return JSON.parse(serialized) as T;
}

const publicSurfaceLoaderMocks = vi.hoisted(() => ({
  loadBundledPluginPublicArtifactModuleSync: vi.fn(
    ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
      if (dirName === "imessage" && artifactBasename === "media-contract-api.js") {
        return {
          resolveInboundAttachmentRoots: ({
            accountId,
            cfg,
          }: {
            accountId?: string | null;
            cfg: OpenClawConfig;
          }) => [
            ...((accountId
              ? cfg.channels?.imessage?.accounts?.[accountId]?.attachmentRoots
              : undefined) ?? []),
            ...(cfg.channels?.imessage?.attachmentRoots ?? []),
            "/Users/*/Library/Messages/Attachments",
          ],
        };
      }
      throw new Error(
        `Unable to resolve bundled plugin public surface ${dirName}/${artifactBasename}`,
      );
    },
  ),
}));

vi.mock("../../plugins/public-surface-loader.js", () => publicSurfaceLoaderMocks);

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

// Keep image-tool tests focused on root propagation; media-tool-shared
// and channel-inbound tests cover the real bundled contract loader.
vi.mock("../../media/channel-inbound-roots.js", () => ({
  resolveChannelInboundAttachmentRootsForChannel: (params: {
    cfg?: OpenClawConfig;
    channelId?: string | null;
    accountId?: string | null;
  }) => {
    const channelId = params.channelId?.trim();
    if (!channelId) {
      return undefined;
    }
    const channelConfig = params.cfg?.channels?.[channelId];
    const accountConfig = params.accountId
      ? channelConfig?.accounts?.[params.accountId]
      : undefined;
    const roots = [
      ...(accountConfig?.attachmentRoots ?? []),
      ...(channelConfig?.attachmentRoots ?? []),
    ];
    return channelId === "imessage" ? [...roots, "/Users/*/Library/Messages/Attachments"] : roots;
  },
}));

function readMockAuthProfileStore(agentDir?: string): {
  version: number;
  profiles: Record<string, { provider?: string; type?: string }>;
} {
  const fallback = {
    version: 1,
    profiles: {} as Record<string, { provider?: string; type?: string }>,
  };
  if (!agentDir) {
    return fallback;
  }
  try {
    return JSON.parse(fsSync.readFileSync(path.join(agentDir, "auth-profiles.json"), "utf8")) as {
      version: number;
      profiles: Record<string, { provider?: string; type?: string }>;
    };
  } catch {
    return fallback;
  }
}

vi.mock("../auth-profiles.js", () => ({
  externalCliDiscoveryForProviderAuth: (params: { provider: string }) => params,
  ensureAuthProfileStore: (agentDir?: string) => {
    const store = readMockAuthProfileStore(agentDir);
    if (process.env.OPENCLAW_TEST_CODEX_CLI_OAUTH === "1") {
      store.profiles["openai:default"] = {
        provider: "openai",
        type: "oauth",
      };
    }
    return store;
  },
  ensureAuthProfileStoreWithoutExternalProfiles: (agentDir?: string) =>
    readMockAuthProfileStore(agentDir),
  hasAnyAuthProfileStoreSource: (agentDir?: string) => {
    if (!agentDir) {
      return false;
    }
    return fsSync.existsSync(path.join(agentDir, "auth-profiles.json"));
  },
  listProfilesForProvider: (
    store: { profiles?: Record<string, { provider?: string }> },
    provider: string,
  ) =>
    Object.entries(store.profiles ?? {})
      .filter(([, profile]) => profile?.provider === provider)
      .map(([profileId]) => profileId),
  resolveAuthProfileOrder: (params: {
    cfg?: OpenClawConfig;
    store: { profiles?: Record<string, { provider?: string }> };
    provider: string;
  }) => {
    const profiles = Object.entries(params.store.profiles ?? {})
      .filter(([, profile]) => profile?.provider === params.provider)
      .map(([profileId]) => profileId);
    const configured = params.cfg?.auth?.order?.[params.provider];
    return configured ? configured.filter((profileId) => profiles.includes(profileId)) : profiles;
  },
}));

vi.mock("../auth-profiles/external-cli-sync.js", () => ({
  resolveExternalCliAuthProfiles: (
    _store: unknown,
    options?: { providerIds?: Iterable<string> },
  ) => {
    const providerIds = new Set(
      Array.from(options?.providerIds ?? []).map((providerId) => providerId.toLowerCase()),
    );
    if (
      process.env.OPENCLAW_TEST_CODEX_CLI_OAUTH !== "1" ||
      (!providerIds.has("openai") && !providerIds.has("codex"))
    ) {
      return [];
    }
    return [
      {
        profileId: "openai:default",
        credential: {
          provider: "openai",
          type: "oauth",
          access: "oauth-test",
          refresh: "refresh-test",
          expires: Date.now() + 60_000,
        },
      },
    ];
  },
}));

vi.mock("../model-auth.js", () => ({
  resolveProviderEntryApiKeyProfileReference: (params: {
    cfg?: OpenClawConfig;
    provider: string;
    store: { profiles?: Record<string, { provider?: string; type?: string }> };
  }) => {
    const apiKey = params.cfg?.models?.providers?.[params.provider]?.apiKey;
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      return { kind: "none" };
    }
    const profile = params.store.profiles?.[apiKey.trim()];
    if (!profile) {
      return { kind: "literal", apiKey: apiKey.trim(), source: "models.json" };
    }
    return { kind: "profile", profileId: apiKey.trim(), credential: profile };
  },
  hasRuntimeAvailableProviderAuth: (params: {
    provider: string;
    cfg?: OpenClawConfig;
    modelApi?: string;
  }) => {
    const providerConfig = params.cfg?.models?.providers?.[params.provider];
    if (params.provider === "openai" && params.modelApi === "openai-responses") {
      return Boolean(process.env.OPENAI_API_KEY || providerConfig?.apiKey);
    }
    return Boolean(providerConfig?.apiKey);
  },
  hasUsableCustomProviderApiKey: (cfg?: OpenClawConfig, provider?: string) => {
    const providerConfig = cfg?.models?.providers?.[provider ?? ""];
    const apiKey = providerConfig?.apiKey;
    return typeof apiKey === "string" && apiKey.trim().length > 0;
  },
  resolveEnvApiKey: (provider: string) => {
    const envVarByProvider: Record<string, string[]> = {
      anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
      minimax: ["MINIMAX_API_KEY", "MINIMAX_OAUTH_TOKEN"],
      "minimax-portal": ["MINIMAX_OAUTH_TOKEN"],
      moonshot: ["MOONSHOT_API_KEY"],
      openai: ["OPENAI_API_KEY"],
      opencode: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
      "opencode-go": ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
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

const minimaxUnderstandImageMock = vi.hoisted(() => vi.fn());
vi.mock("../minimax-vlm.js", async () => {
  const mod = await vi.importActual<typeof import("../minimax-vlm.js")>("../minimax-vlm.js");
  return {
    ...mod,
    minimaxUnderstandImage: minimaxUnderstandImageMock,
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

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBBsGAQr00ED3AAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA0LTI3VDA2OjAxOjEwKzAwOjAwPU3tXwAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wNC0yN1QwNjowMToxMCswMDowMEwQVeMAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDQtMjdUMDY6MDE6MTArMDA6MDAbBXQ8AAAAeElEQVRo3u3awQnDQBAEwT2Q8w/YAikIP5rF1RFMca+FO8/s7rrnqjcA1BsA6g0A9QaAesOfA77zqTf8Blj/AgAAAAAAAJsDqAOoA6gDqAOoc9TXAdQB1AHUAdQB1AHUAdQB1AHU7Qc46gEAAAAANrcecGZ2f8B/ASYSQPlKoEJ/AAAAAElFTkSuQmCC";
const ONE_PIXEL_GIF_B64 = "R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=";

function createLargeColorBlockPng(size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4, 255);
  const centerStart = Math.floor(size * 0.25);
  const centerEnd = Math.floor(size * 0.75);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inCenter = x >= centerStart && x < centerEnd && y >= centerStart && y < centerEnd;
      fillPixel(buf, x, y, size, inCenter ? 230 : 30, inCenter ? 40 : 110, inCenter ? 35 : 220);
    }
  }
  return encodePngRgba(buf, size, size);
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } {
  // The tests inspect JPEG SOF markers directly so resize assertions do not
  // depend on an external decoder.
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = expectDefined(buffer[offset + 1], "buffer[offset + 1] test invariant");
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    const segmentLength = buffer.readUInt16BE(offset);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  throw new Error("JPEG dimensions not found");
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("PNG dimensions not found");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

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
  minimaxUnderstandImageMock.mockReset();
  vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
  minimaxUnderstandImageMock.mockResolvedValue("ok");
  // Tests that fall back to the generic image runtime still hit a mocked
  // global.fetch because media-understanding/image.ts is not behind the
  // minimax-vlm module mock.
  const fetch = vi.fn().mockImplementation(async () =>
    Response.json({
      content: "ok",
      base_resp: { status_code: 0, status_msg: "" },
    }),
  );
  global.fetch = withFetchPreconnect(fetch);
  return minimaxUnderstandImageMock;
}

function stubMinimaxFetch(baseResp: { status_code: number; status_msg: string }, content = "ok") {
  minimaxUnderstandImageMock.mockReset();
  if (baseResp.status_code !== 0) {
    minimaxUnderstandImageMock.mockRejectedValue(
      new Error(
        `MiniMax VLM API error (${baseResp.status_code})${
          baseResp.status_msg ? `: ${baseResp.status_msg}` : ""
        }.`,
      ),
    );
  } else {
    minimaxUnderstandImageMock.mockResolvedValue(content);
  }
  const fetch = vi.fn().mockImplementation(async () =>
    Response.json({
      content,
      base_resp: baseResp,
    }),
  );
  global.fetch = withFetchPreconnect(fetch);
  return minimaxUnderstandImageMock;
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

const codexMediaProvider = {
  id: "codex",
  capabilities: ["image"],
  defaultModels: { image: "gpt-5.5" },
} satisfies MediaUnderstandingProvider;

const resolveConfiguredImageModelForTest: NonNullable<
  Parameters<typeof testing.setProviderDepsForTest>[0]
>["resolveModelAsync"] = async (provider, model, _agentDir, cfg) => {
  const configuredModel = cfg?.models?.providers?.[provider]?.models?.find(
    (candidate) => candidate.id === model || candidate.id === `${provider}/${model}`,
  );
  return {
    model: {
      ...configuredModel,
      id: model,
      provider,
      input: configuredModel?.input ?? ["text", "image"],
    } as never,
    authStorage: {} as never,
    modelRegistry: {} as never,
  };
};

function installImageUnderstandingProviderDeps(
  providers: MediaUnderstandingProvider[],
  options?: {
    describeImageWithModel?: NonNullable<
      Parameters<typeof testing.setProviderDepsForTest>[0]
    >["describeImageWithModel"];
    describeImagesWithModel?: NonNullable<
      Parameters<typeof testing.setProviderDepsForTest>[0]
    >["describeImagesWithModel"];
    loadImageWebMediaRuntime?: NonNullable<
      Parameters<typeof testing.setProviderDepsForTest>[0]
    >["loadImageWebMediaRuntime"];
    resolveImageCompressionPolicy?: NonNullable<
      Parameters<typeof testing.setProviderDepsForTest>[0]
    >["resolveImageCompressionPolicy"];
    resolveModelAsync?: NonNullable<
      Parameters<typeof testing.setProviderDepsForTest>[0]
    >["resolveModelAsync"];
  },
) {
  imageProviderHarness.setProviders(providers);
  const defaultImageModels = new Map<string, string>([
    ["anthropic", "claude-opus-4-6"],
    ["minimax", "MiniMax-VL-01"],
    ["minimax-cn", "MiniMax-VL-01"],
    ["minimax-portal", "MiniMax-VL-01"],
    ["minimax-portal-cn", "MiniMax-VL-01"],
    ["codex", "gpt-5.5"],
    ["openai", "gpt-5.4-mini"],
    ["opencode", "gpt-5-nano"],
    ["opencode-go", "kimi-k2.6"],
    ["zai", "glm-4.6v"],
  ]);
  testing.setProviderDepsForTest({
    buildProviderRegistry: (overrides?: Record<string, MediaUnderstandingProvider>) =>
      imageProviderHarness.buildProviderRegistry(overrides),
    getMediaUnderstandingProvider: (
      id: string,
      registry: Map<string, MediaUnderstandingProvider>,
    ) => imageProviderHarness.getMediaUnderstandingProvider(id, registry),
    describeImageWithModel: options?.describeImageWithModel ?? describeGenericImageWithModel,
    describeImagesWithModel: options?.describeImagesWithModel ?? describeGenericImagesWithModel,
    resolveAutoMediaKeyProviders: ({ capability }) =>
      capability === "image" ? ["openai", "anthropic"] : [],
    resolveDefaultMediaModel: ({ providerId, capability }) =>
      capability === "image" ? defaultImageModels.get(providerId.toLowerCase()) : undefined,
    resolveRegisteredMediaUnderstandingProvider: ({ providerId }) =>
      imageProviderHarness.getMediaUnderstandingProvider(
        providerId,
        imageProviderHarness.buildProviderRegistry(),
      ),
    resolveModelAsync: options?.resolveModelAsync ?? resolveConfiguredImageModelForTest,
    ...(options?.resolveImageCompressionPolicy
      ? { resolveImageCompressionPolicy: options.resolveImageCompressionPolicy }
      : {}),
    ...(options?.loadImageWebMediaRuntime
      ? { loadImageWebMediaRuntime: options.loadImageWebMediaRuntime }
      : {}),
  });
}

function installImageUnderstandingProviderStubs(...providers: MediaUnderstandingProvider[]) {
  installImageUnderstandingProviderDeps(providers);
}

function installFastLocalImageProviderStubs(...providers: MediaUnderstandingProvider[]) {
  installImageUnderstandingProviderDeps(providers, {
    describeImageWithModel: async () => {
      throw new Error("Expected fast local image tests to use a registered image provider");
    },
    describeImagesWithModel: async () => {
      throw new Error("Expected fast local image tests to use a registered image provider");
    },
    resolveImageCompressionPolicy: async ({ imageCount }) => ({ imageCount }),
    loadImageWebMediaRuntime: async () => ({
      loadWebMedia: async (mediaUrl, options) => {
        const localRoots =
          options && typeof options !== "number" && "localRoots" in options
            ? options.localRoots
            : [];
        const inboundRoots =
          options && typeof options !== "number" && "inboundRoots" in options
            ? options.inboundRoots
            : [];
        if (
          localRoots !== "any" &&
          !isInboundPathAllowed({
            filePath: mediaUrl,
            roots: [...(localRoots ?? []), ...(inboundRoots ?? [])],
          })
        ) {
          throw new Error(`Local media path is not under an allowed directory: ${mediaUrl}`);
        }
        const readFile =
          options && typeof options !== "number" && "readFile" in options
            ? options.readFile
            : undefined;
        return {
          buffer: readFile ? await readFile(mediaUrl) : await fs.readFile(mediaUrl),
          contentType: "image/png",
          kind: "image",
          fileName: path.basename(mediaUrl),
        };
      },
      optimizeImageBufferForWebMedia: async ({ buffer, contentType, fileName }) => {
        return {
          buffer,
          contentType: contentType ?? "image/png",
          kind: "image",
          fileName,
        };
      },
    }),
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
  const result = await tool.execute("t1", {
    prompt: "Describe the image.",
    image,
  });
  expectToolText(result, "ok");
}

type ToolTextResult = {
  content?: Array<{
    type?: string;
    text?: string;
    image_url?: { url?: string };
  }>;
  details?: Record<string, unknown>;
};

function expectToolText(result: unknown, text: string): void {
  const content = (result as ToolTextResult).content ?? [];
  expect(content.some((block) => block.type === "text" && block.text === text)).toBe(true);
}

function firstImageRequest(mock: { mock: { calls: unknown[][] } }): ImageDescriptionRequest {
  const request = mock.mock.calls.at(0)?.[0];
  if (!request) {
    throw new Error("expected describeImage call");
  }
  return request as ImageDescriptionRequest;
}

function fetchCallAt(mock: { mock: { calls: unknown[][] } }, index: number): unknown[] {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected fetch call ${index + 1}`);
  }
  return call;
}

function requireImageTool<T>(tool: T | null | undefined): T {
  expect(typeof (tool as { execute?: unknown } | null | undefined)?.execute).toBe("function");
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

function findSchemaUnionKeywords(schema: unknown, pathLocal = "root"): string[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) => findSchemaUnionKeywords(item, `${pathLocal}[${index}]`));
  }
  const record = schema as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    const nextPath = `${pathLocal}.${key}`;
    if (key === "anyOf" || key === "oneOf" || key === "allOf") {
      out.push(nextPath);
    }
    out.push(...findSchemaUnionKeywords(value, nextPath));
  }
  return out;
}

describe("image tool implicit imageModel config", () => {
  type Profiles = AuthProfileStore["profiles"];
  type ImplicitImageRoutingCase = {
    name: string;
    cfg: OpenClawConfig;
    profiles?: Profiles;
    codexProvider?: boolean;
    openAiApiKey?: boolean;
    expected: ReturnType<typeof resolveImageModelConfigForTool>;
  };

  const openAiPrimaryCfg = {
    agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
  } satisfies OpenClawConfig;
  const anthropicPrimaryCfg = {
    agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
  } satisfies OpenClawConfig;
  const codexImageModel = { primary: "codex/gpt-5.5" };
  const openAiDefaultImageModel = { primary: "openai/gpt-5.4-mini" };

  const openAiOAuthProfile = (provider = "openai"): AuthProfileCredential => ({
    provider,
    type: "oauth" as const,
    access: "oauth-test",
    refresh: "refresh-test",
    expires: Date.now() + 60_000,
  });

  const openAiTokenProfile = (provider = "openai"): AuthProfileCredential => ({
    provider,
    type: "token" as const,
    token: "token-test",
  });

  const makeAuthStore = (profiles: Profiles): AuthProfileStore => ({ version: 1, profiles });
  const writeProfiles = (agentDir: string, profiles: Profiles) =>
    writeAuthProfiles(agentDir, makeAuthStore(profiles));

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
    "OPENCLAW_TEST_CODEX_CLI_OAUTH",
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
    testing.setProviderDepsForTest();
  });

  const implicitImageRoutingCases: ImplicitImageRoutingCase[] = [
    {
      name: "uses Codex media for implicit OpenAI image defaults on canonical OAuth-only auth",
      cfg: openAiPrimaryCfg,
      profiles: { "openai:chatgpt": openAiOAuthProfile() },
      codexProvider: true,
      expected: codexImageModel,
    },
    {
      name: "uses Codex media for implicit OpenAI image defaults on canonical token-only auth",
      cfg: openAiPrimaryCfg,
      profiles: { "openai:token": openAiTokenProfile() },
      codexProvider: true,
      expected: codexImageModel,
    },
    {
      name: "uses Codex media for implicit OpenAI image auto candidates on OAuth-only auth",
      cfg: anthropicPrimaryCfg,
      profiles: { "openai:chatgpt": openAiOAuthProfile() },
      codexProvider: true,
      expected: codexImageModel,
    },
    {
      name: "drops implicit OpenAI image auto candidates on OAuth-only auth without Codex route",
      cfg: anthropicPrimaryCfg,
      profiles: { "openai:chatgpt": openAiOAuthProfile() },
      expected: null,
    },
    {
      name: "keeps implicit OpenAI image auto candidates when direct OpenAI API key auth exists",
      cfg: anthropicPrimaryCfg,
      openAiApiKey: true,
      expected: openAiDefaultImageModel,
    },
    {
      name: "keeps implicit OpenAI image defaults when direct OpenAI API key auth exists",
      cfg: openAiPrimaryCfg,
      openAiApiKey: true,
      expected: openAiDefaultImageModel,
    },
    {
      name: "does not treat legacy openai-codex profiles as canonical Codex OAuth",
      cfg: openAiPrimaryCfg,
      profiles: { "openai-codex:default": openAiOAuthProfile("openai-codex") },
      codexProvider: true,
      expected: null,
    },
  ];

  it("stays disabled without auth when no pairing is possible", async () => {
    await withTempAgentDir(async (agentDir) => {
      expect(resolveImageModelConfigForTool({ cfg: openAiPrimaryCfg, agentDir })).toBeNull();
      expect(createImageTool({ config: openAiPrimaryCfg, agentDir })).toBeNull();
    });
  });

  it("does not mix a prepared media family with a live Codex provider", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeProfiles(agentDir, { "openai:chatgpt": openAiOAuthProfile() });
      installImageUnderstandingProviderStubs(minimaxProvider, moonshotProvider, codexMediaProvider);

      expect(
        resolveImageModelConfigForTool({
          cfg: openAiPrimaryCfg,
          agentDir,
          preparedModelRuntime: {
            mediaCapabilityProviders: { mediaUnderstandingProviders: [] },
          } as never,
        }),
      ).toBeNull();
    });
  });

  it("resolves a Codex alias from the prepared media family", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeProfiles(agentDir, { "openai:chatgpt": openAiOAuthProfile() });

      expect(
        resolveImageModelConfigForTool({
          cfg: openAiPrimaryCfg,
          agentDir,
          preparedModelRuntime: {
            mediaCapabilityProviders: {
              mediaUnderstandingProviders: [
                { ...codexMediaProvider, id: "codex-owner", aliases: ["codex"] },
              ],
            },
          } as never,
        }),
      ).toEqual(codexImageModel);
    });
  });

  it.each(implicitImageRoutingCases)(
    "$name",
    async ({ cfg, profiles, codexProvider, openAiApiKey, expected }) => {
      if (codexProvider) {
        installImageUnderstandingProviderStubs(
          minimaxProvider,
          moonshotProvider,
          codexMediaProvider,
        );
      }
      if (openAiApiKey) {
        vi.stubEnv("OPENAI_API_KEY", "openai-test");
      }
      await withTempAgentDir(async (agentDir) => {
        if (profiles) {
          await writeProfiles(agentDir, profiles);
        }

        const actual = resolveImageModelConfigForTool({ cfg, agentDir });
        if (expected === null) {
          expect(actual).toBeNull();
        } else {
          expect(actual).toEqual(expected);
        }
      });
    },
  );

  it("uses Codex media when OAuth-only OpenAI has configured vision model metadata", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeProfiles(agentDir, { "openai:chatgpt": openAiOAuthProfile() });
      installImageUnderstandingProviderStubs(minimaxProvider, moonshotProvider, codexMediaProvider);
      const cfg: OpenClawConfig = {
        ...openAiPrimaryCfg,
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [makeModelDefinition("gpt-5.5", ["text", "image"])],
            },
          },
        },
      };

      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: codexImageModel.primary,
      });
    });
  });

  it("keeps configured OpenAI vision metadata when direct OpenAI API key auth exists", async () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        ...openAiPrimaryCfg,
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [makeModelDefinition("gpt-5.5", ["text", "image"])],
            },
          },
        },
      };

      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "openai/gpt-5.5",
        fallbacks: [openAiDefaultImageModel.primary],
      });
    });
  });

  it("preserves explicit OpenAI image model config without direct auth", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
            imageModel: { primary: "openai/gpt-5.5" },
          },
        },
      };

      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "openai/gpt-5.5",
      });
    });
  });

  it("preserves explicit Codex image model config", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
            imageModel: codexImageModel,
          },
        },
      };

      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual(codexImageModel);
    });
  });

  it("lets external CLI Codex OAuth survive the candidate auth filter", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("OPENCLAW_TEST_CODEX_CLI_OAUTH", "1");
      installImageUnderstandingProviderStubs(minimaxProvider, moonshotProvider, codexMediaProvider);

      expect(resolveImageModelConfigForTool({ cfg: openAiPrimaryCfg, agentDir })).toEqual(
        codexImageModel,
      );
    });
  });

  it("lets external CLI Codex OAuth survive a supplied scoped auth store", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("OPENCLAW_TEST_CODEX_CLI_OAUTH", "1");
      installImageUnderstandingProviderStubs(minimaxProvider, moonshotProvider, codexMediaProvider);

      expect(
        resolveImageModelConfigForTool({
          cfg: openAiPrimaryCfg,
          agentDir,
          authStore: makeAuthStore({}),
        }),
      ).toEqual(codexImageModel);
    });
  });

  it("does not re-import persisted OpenAI OAuth when a scoped auth store is supplied", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeProfiles(agentDir, { "openai:chatgpt": openAiOAuthProfile() });
      installImageUnderstandingProviderStubs(minimaxProvider, moonshotProvider, codexMediaProvider);

      expect(
        resolveImageModelConfigForTool({
          cfg: openAiPrimaryCfg,
          agentDir,
          authStore: makeAuthStore({}),
        }),
      ).toBeNull();
    });
  });

  it("defers implicit image model discovery during hot-path tool registration", async () => {
    await withTempAgentDir(async (agentDir) => {
      const resolveDefaultMediaModelSpy = vi.fn(() => "gpt-5.4-mini");
      const resolveAutoMediaKeyProvidersSpy = vi.fn(() => ["openai"]);
      testing.setProviderDepsForTest({
        buildProviderRegistry: (overrides?: Record<string, MediaUnderstandingProvider>) =>
          imageProviderHarness.buildProviderRegistry(overrides),
        getMediaUnderstandingProvider: (
          id: string,
          registry: Map<string, MediaUnderstandingProvider>,
        ) => imageProviderHarness.getMediaUnderstandingProvider(id, registry),
        describeImageWithModel: describeGenericImageWithModel,
        describeImagesWithModel: describeGenericImagesWithModel,
        resolveDefaultMediaModel: resolveDefaultMediaModelSpy,
        resolveAutoMediaKeyProviders: resolveAutoMediaKeyProvidersSpy,
      });
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
      };

      const tool = createImageTool({
        config: cfg,
        agentDir,
        deferAutoModelResolution: true,
      });

      expect(typeof tool?.execute).toBe("function");
      expect(resolveDefaultMediaModelSpy).not.toHaveBeenCalled();
      expect(resolveAutoMediaKeyProvidersSpy).not.toHaveBeenCalled();
    });
  });

  it("honors a per-call model override when no imageModel is configured", async () => {
    await withTempAgentDir(async (agentDir) => {
      const describeImage = vi.fn(async (params: ImageDescriptionRequest) => ({
        text: `ok ${params.provider}/${params.model}`,
        model: params.model,
      }));
      installFastLocalImageProviderStubs({
        id: "opencode-go",
        capabilities: ["image"],
        describeImage,
      });
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "opencode-go/kimi-k2.6" } } },
      };
      const tool = createRequiredImageTool({
        config: cfg,
        agentDir,
        deferAutoModelResolution: true,
      });

      const result = await tool.execute("t1", {
        prompt: "Describe this image.",
        image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
        model: "opencode-go/mimo-v2.5",
      });

      const request = firstImageRequest(describeImage);
      expect(request.provider).toBe("opencode-go");
      expect(request.model).toBe("mimo-v2.5");
      expectToolText(result, "ok opencode-go/mimo-v2.5");
    });
  });

  it("carries the scoped auth store into image provider execution", async () => {
    await withTempAgentDir(async (agentDir) => {
      const describeImage = vi.fn(async (params: ImageDescriptionRequest) => ({
        text: "ok",
        model: params.model,
      }));
      installImageUnderstandingProviderStubs({
        id: "codex",
        capabilities: ["image"],
        describeImage,
      });
      const authProfileStore = makeAuthStore({
        "openai:scoped": openAiOAuthProfile(),
      });
      const tool = createRequiredImageTool({
        config: { agents: { defaults: { imageModel: { primary: "codex/gpt-5.5" } } } },
        agentDir,
        authProfileStore,
      });

      await tool.execute("t1", {
        prompt: "Describe this image.",
        image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      });

      expect(firstImageRequest(describeImage).authStore).toBe(authProfileStore);
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
      expect(typeof createImageTool({ config: cfg, agentDir })?.execute).toBe("function");
    });
  });

  it("does not treat configured MiniMax M2.7 chat metadata as the image model", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
      vi.stubEnv("OPENAI_API_KEY", "openai-test");
      vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "minimax/MiniMax-M2.7" } } },
        models: {
          mode: "merge",
          providers: {
            minimax: {
              baseUrl: "https://api.minimax.io/anthropic",
              apiKey: "${MINIMAX_API_KEY}",
              api: "anthropic-messages",
              models: [makeModelDefinition("MiniMax-M2.7", ["text"])],
            },
          },
        },
      };
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        ...createDefaultImageFallbackExpectation("minimax/MiniMax-VL-01"),
        fallbacks: ["openai/gpt-5.4-mini", "anthropic/claude-opus-4-6"],
      });
      expect(typeof createImageTool({ config: cfg, agentDir })?.execute).toBe("function");
    });
  });

  it("keeps MiniMax CN chat metadata off automatic image routing", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "minimax-cn/MiniMax-M2.5" } } },
        models: {
          mode: "merge",
          providers: {
            "minimax-cn": {
              baseUrl: "https://api.minimaxi.com/anthropic",
              apiKey: "${MINIMAX_API_KEY}",
              api: "anthropic-messages",
              models: [makeModelDefinition("MiniMax-M2.5", ["text", "image"])],
            },
          },
        },
      };
      const authStore = {
        version: 1,
        profiles: {
          mini: { type: "api_key", provider: "minimax-cn", key: "minimax-test" },
          miniGlobal: { type: "api_key", provider: "minimax", key: "minimax-test" },
        },
      } as const;

      expect(resolveImageModelConfigForTool({ cfg, agentDir, authStore })).toEqual({
        primary: "minimax-cn/MiniMax-VL-01",
      });
    });
  });

  it("prefers configured MiniMax CN image alias over canonical auto fallback", async () => {
    await withTempAgentDir(async (agentDir) => {
      const defaultImageModels = new Map<string, string>([
        ["anthropic", "claude-opus-4-6"],
        ["minimax", "MiniMax-VL-01"],
        ["minimax-cn", "MiniMax-VL-01"],
        ["openai", "gpt-5.4-mini"],
      ]);
      testing.setProviderDepsForTest({
        buildProviderRegistry: (overrides?: Record<string, MediaUnderstandingProvider>) =>
          imageProviderHarness.buildProviderRegistry(overrides),
        getMediaUnderstandingProvider: (
          id: string,
          registry: Map<string, MediaUnderstandingProvider>,
        ) => imageProviderHarness.getMediaUnderstandingProvider(id, registry),
        describeImageWithModel: describeGenericImageWithModel,
        describeImagesWithModel: describeGenericImagesWithModel,
        resolveAutoMediaKeyProviders: ({ capability }) =>
          capability === "image" ? ["openai", "anthropic", "minimax-cn", "minimax"] : [],
        resolveDefaultMediaModel: ({ providerId, capability }) =>
          capability === "image" ? defaultImageModels.get(providerId.toLowerCase()) : undefined,
      });
      const cfg: OpenClawConfig = {
        models: {
          mode: "merge",
          providers: {
            "minimax-cn": {
              baseUrl: "https://api.minimaxi.com/anthropic",
              apiKey: "${MINIMAX_API_KEY}",
              api: "anthropic-messages",
              models: [makeModelDefinition("MiniMax-M2.5", ["text", "image"])],
            },
          },
        },
      };
      const authStore = {
        version: 1,
        profiles: {
          mini: { type: "api_key", provider: "minimax-cn", key: "minimax-test" },
          miniGlobal: { type: "api_key", provider: "minimax", key: "minimax-test" },
        },
      } as const;

      expect(resolveImageModelConfigForTool({ cfg, agentDir, authStore })).toEqual({
        primary: "minimax-cn/MiniMax-VL-01",
      });
    });
  });

  it("keeps canonical MiniMax fallback when configured CN alias has no image candidate", async () => {
    await withTempAgentDir(async (agentDir) => {
      testing.setProviderDepsForTest({
        buildProviderRegistry: (overrides?: Record<string, MediaUnderstandingProvider>) =>
          imageProviderHarness.buildProviderRegistry(overrides),
        getMediaUnderstandingProvider: (
          id: string,
          registry: Map<string, MediaUnderstandingProvider>,
        ) => imageProviderHarness.getMediaUnderstandingProvider(id, registry),
        describeImageWithModel: describeGenericImageWithModel,
        describeImagesWithModel: describeGenericImagesWithModel,
        resolveAutoMediaKeyProviders: ({ capability }) =>
          capability === "image" ? ["minimax"] : [],
        resolveDefaultMediaModel: ({ providerId, capability }) =>
          capability === "image" && providerId === "minimax" ? "MiniMax-VL-01" : undefined,
      });
      const cfg: OpenClawConfig = {
        models: {
          mode: "merge",
          providers: {
            "minimax-cn": {
              baseUrl: "https://api.minimaxi.com/anthropic",
              apiKey: "${MINIMAX_API_KEY}",
              api: "anthropic-messages",
              models: [],
            },
          },
        },
      };
      const authStore = {
        version: 1,
        profiles: {
          miniGlobal: { type: "api_key", provider: "minimax", key: "minimax-test" },
        },
      } as const;

      expect(resolveImageModelConfigForTool({ cfg, agentDir, authStore })).toEqual({
        primary: "minimax/MiniMax-VL-01",
      });
    });
  });

  it("passes the configured image timeout to provider calls", async () => {
    await withTempWorkspacePng(async ({ workspaceDir, imagePath }) => {
      await withTempAgentDir(async (agentDir) => {
        const describeImage = vi.fn(async (params: ImageDescriptionRequest) => ({
          text: "ok",
          model: params.model,
        }));
        installFastLocalImageProviderStubs({
          id: "ollama",
          capabilities: ["image"],
          describeImage,
        });
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              imageModel: { primary: "ollama/gemma4:26b-a4b-it-q4_K_M" },
            },
          },
          tools: {
            media: {
              image: { timeoutSeconds: 180 },
            },
          },
        };
        const tool = createRequiredImageTool({ config: cfg, agentDir, workspaceDir });

        await expectImageToolExecOk(tool, imagePath);

        expect(firstImageRequest(describeImage).timeoutMs).toBe(180_000);
      });
    });
  });

  it("prefers a matching per-image-model timeout over the capability timeout", async () => {
    await withTempWorkspacePng(async ({ workspaceDir, imagePath }) => {
      await withTempAgentDir(async (agentDir) => {
        const describeImage = vi.fn(async (params: ImageDescriptionRequest) => ({
          text: "ok",
          model: params.model,
        }));
        installFastLocalImageProviderStubs({
          id: "ollama",
          capabilities: ["image"],
          describeImage,
        });
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              imageModel: { primary: "ollama/gemma4:26b-a4b-it-q4_K_M" },
            },
          },
          tools: {
            media: {
              image: { timeoutSeconds: 180 },
              models: [
                {
                  provider: "ollama",
                  model: "gemma4:26b-a4b-it-q4_K_M",
                  timeoutSeconds: 300,
                  capabilities: ["image"],
                },
              ],
            },
          },
        };
        const tool = createRequiredImageTool({ config: cfg, agentDir, workspaceDir });

        await expectImageToolExecOk(tool, imagePath);

        expect(firstImageRequest(describeImage).timeoutMs).toBe(300_000);
      });
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
      expect(typeof createImageTool({ config: cfg, agentDir })?.execute).toBe("function");
    });
  });

  it("pairs opencode primary with the plugin-owned image model when auth exists", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("OPENCODE_API_KEY", "opencode-test");
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "opencode/minimax-m2.7" } } },
      };
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "opencode/gpt-5-nano",
      });
      expect(typeof createImageTool({ config: cfg, agentDir })?.execute).toBe("function");
    });
  });

  it("pairs opencode-go primary with the Go plugin-owned image model when auth exists", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("OPENCODE_API_KEY", "opencode-test");
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "opencode-go/minimax-m2.7" } } },
      };
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "opencode-go/kimi-k2.6",
      });
      expect(typeof createImageTool({ config: cfg, agentDir })?.execute).toBe("function");
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
      expect(typeof createImageTool({ config: cfg, agentDir })?.execute).toBe("function");
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
      expect(typeof createImageTool({ config: cfg, agentDir })?.execute).toBe("function");
    });
  });

  it("pairs a custom provider when config declares its api key", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "hatchery-qwen3.6-plus/text-1" } } },
        models: {
          providers: {
            "hatchery-qwen3.6-plus": {
              baseUrl: "https://example.com",
              apiKey: "sk-configured", // pragma: allowlist secret
              models: [
                makeModelDefinition("text-1", ["text"]),
                makeModelDefinition("qwen3.6-plus", ["text", "image"]),
              ],
            },
          },
        },
      };
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "hatchery-qwen3.6-plus/qwen3.6-plus",
      });
      expect(typeof createImageTool({ config: cfg, agentDir })?.execute).toBe("function");
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

  it("does not pair provider aliases through core normalization", async () => {
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
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toBeNull();
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

  it("resolves providerless explicit image models from unique configured image providers", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            imageModel: {
              primary: "moondream",
              fallbacks: ["qwen2.5vl:7b", "G-2.5-f"],
            },
          },
        },
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [
                makeModelDefinition("moondream", ["text", "image"]),
                makeModelDefinition("qwen2.5vl:7b", ["text", "image"]),
                makeModelDefinition("G-2.5-f", ["text", "image"]),
              ],
            },
          },
        },
      };

      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "ollama/moondream",
        fallbacks: ["ollama/qwen2.5vl:7b", "ollama/G-2.5-f"],
      });
    });
  });

  it("runs providerless explicit image models on the inferred provider", async () => {
    await withTempAgentDir(async (agentDir) => {
      const describeImage = vi.fn(async (params: ImageDescriptionRequest) => ({
        text: `ok ${params.model}`,
        model: params.model,
      }));
      installFastLocalImageProviderStubs({
        id: "ollama",
        capabilities: ["image"],
        describeImage,
      });
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            imageModel: { primary: "moondream" },
          },
        },
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [makeModelDefinition("moondream", ["text", "image"])],
            },
          },
        },
      };

      const tool = requireImageTool(createImageTool({ config: cfg, agentDir }));
      const result = await tool.execute("t1", {
        prompt: "Describe this image in one word.",
        image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      });

      const request = firstImageRequest(describeImage);
      expect(request.provider).toBe("ollama");
      expect(request.model).toBe("moondream");
      expectToolText(result, "ok moondream");
    });
  });

  it("rejects ambiguous providerless explicit image models", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            imageModel: { primary: "moondream" },
          },
        },
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [makeModelDefinition("moondream", ["text", "image"])],
            },
            lmstudio: {
              baseUrl: "http://localhost:1234",
              models: [makeModelDefinition("moondream", ["text", "image"])],
            },
          },
        },
      };

      expect(() => resolveImageModelConfigForTool({ cfg, agentDir })).toThrow(
        'Ambiguous image model "moondream"',
      );
    });
  });

  it("keeps unmatched providerless explicit image models on the legacy default-provider path", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            imageModel: { primary: "gpt-5.4-mini" },
          },
        },
      };

      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "gpt-5.4-mini",
      });
    });
  });

  it("loads images directly for native-vision models without resolving an image model", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "acme/vision-1" },
            imageModel: { primary: "moondream" },
            imageMaxDimensionPx: 32,
          },
        },
        models: {
          providers: {
            acme: {
              baseUrl: "https://example.com",
              models: [makeModelDefinition("vision-1", ["text", "image"])],
            },
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [makeModelDefinition("moondream", ["text", "image"])],
            },
            lmstudio: {
              baseUrl: "http://localhost:1234",
              models: [makeModelDefinition("moondream", ["text", "image"])],
            },
          },
        },
      };
      const describeImageWithModel = vi.fn(async () => {
        throw new Error("native image loading must not call a fallback model");
      });
      const describeImagesWithModel = vi.fn(async () => {
        throw new Error("native image loading must not call a fallback model");
      });
      testing.setProviderDepsForTest({ describeImageWithModel, describeImagesWithModel });

      const tool = createRequiredImageTool({ config: cfg, agentDir, modelHasVision: true });
      expect(tool.label).toBe("View Image");
      expect(tool.catalogMode).toBe("direct-only");
      expect(tool.description).toContain("direct visual inspection");

      const result = await tool.execute("native-image", {
        prompt: "Read the screenshot error.",
        image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      });
      const content = (
        result as {
          content?: Array<{ type?: string; data?: string; mimeType?: string }>;
          details?: Record<string, unknown>;
        }
      ).content;

      expect(content).toEqual([
        { type: "text", text: "Loaded 1 image for direct visual inspection." },
        expect.objectContaining({ type: "image", mimeType: "image/jpeg" }),
      ]);
      expect((result as { details?: Record<string, unknown> }).details).toMatchObject({
        transport: "native",
      });
      expect(describeImageWithModel).not.toHaveBeenCalled();
      expect(describeImagesWithModel).not.toHaveBeenCalled();
    });
  });

  it("sends moonshot image requests with user+image payloads only", async () => {
    await withTempAgentDir(async (agentDir) => {
      installFastLocalImageProviderStubs(minimaxProvider, moonshotProvider);
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
      const [url, init] = fetchCallAt(fetch, 0) as [unknown, { body?: unknown }];
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
      expect(
        userContent.some(
          (block) => block.type === "text" && block.text === "Describe this image in one word.",
        ),
      ).toBe(true);
      expect(userContent.some((block) => block.type === "image_url")).toBe(true);
      expect(userContent.find((block) => block.type === "image_url")?.image_url?.url).toContain(
        "data:image/",
      );
      expect(bodyRaw).not.toContain('"role":"developer"');
      expectToolText(result, "ok moonshot");
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
      expectToolText(result, "ok openrouter");
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
      expectToolText(result, "ok multi");
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
      // The generic image runtime still uses global.fetch, so mock it directly.
      const fetch = vi.fn().mockImplementation(async () =>
        Response.json({
          content: "ok",
          base_resp: { status_code: 0, status_msg: "" },
        }),
      );
      global.fetch = withFetchPreconnect(fetch);
      vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
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
      expect(violations).toStrictEqual([]);

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
      expect(jsonRoundTrip(tool.parameters)).toEqual({
        type: "object",
        properties: {
          prompt: { type: "string" },
          image: { description: "One image path/URL.", type: "string" },
          images: {
            description: "Image paths/URLs; maxImages default 20.",
            type: "array",
            items: { type: "string" },
          },
          model: { type: "string" },
          maxBytesMb: { type: "number", exclusiveMinimum: 0 },
          maxImages: { type: "integer", minimum: 1 },
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

  it("allows image paths from the current iMessage account attachment roots", async () => {
    await withTempAgentDir(async (agentDir) => {
      const describeImage = vi.fn(async (params: ImageDescriptionRequest) => ({
        text: "ok",
        model: params.model,
      }));
      installFastLocalImageProviderStubs({
        id: "ollama",
        capabilities: ["image"],
        describeImage,
      });
      const attachmentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-root-"));
      const imagePath = path.join(attachmentRoot, "photo.png");
      await fs.writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
      try {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              imageModel: { primary: "ollama/moondream" },
            },
          },
          models: {
            providers: {
              ollama: {
                baseUrl: "http://localhost:11434",
                models: [makeModelDefinition("moondream", ["text", "image"])],
              },
            },
          },
          channels: {
            imessage: {
              accounts: {
                work: {
                  attachmentRoots: [attachmentRoot],
                },
              },
            },
          },
        };

        expect(resolveMediaToolInboundRoots({ cfg })).toEqual([]);
        const roots = resolveMediaToolInboundRoots({
          cfg,
          channelId: "imessage",
          accountId: "work",
        });
        expect(roots).toContain(attachmentRoot);
        expect(isInboundPathAllowed({ filePath: imagePath, roots })).toBe(true);

        const withoutChannel = createRequiredImageTool({ config: cfg, agentDir });
        await expect(
          withoutChannel.execute("t1", { prompt: "Describe.", image: imagePath }),
        ).rejects.toThrow(/not under an allowed directory/i);

        const withImessage = createRequiredImageTool({
          config: cfg,
          agentDir,
          agentChannel: "imessage",
          agentAccountId: "work",
        });

        await expectImageToolExecOk(withImessage, imagePath);
        expect(describeImage).toHaveBeenCalledTimes(1);
      } finally {
        await fs.rm(attachmentRoot, { recursive: true, force: true });
      }
    });
  });

  it("allows image paths from current iMessage wildcard attachment roots", async () => {
    await withTempAgentDir(async (agentDir) => {
      const describeImage = vi.fn(async (params: ImageDescriptionRequest) => ({
        text: "ok",
        model: params.model,
      }));
      installFastLocalImageProviderStubs({
        id: "ollama",
        capabilities: ["image"],
        describeImage,
      });
      const attachmentRootParent = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-imessage-wildcard-root-"),
      );
      const attachmentRoot = path.join(attachmentRootParent, "work", "Attachments");
      const imagePath = path.join(attachmentRoot, "photo.png");
      await fs.mkdir(attachmentRoot, { recursive: true });
      await fs.writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
      try {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              imageModel: { primary: "ollama/moondream" },
            },
          },
          models: {
            providers: {
              ollama: {
                baseUrl: "http://localhost:11434",
                models: [makeModelDefinition("moondream", ["text", "image"])],
              },
            },
          },
          channels: {
            imessage: {
              accounts: {
                work: {
                  attachmentRoots: [path.join(attachmentRootParent, "*", "Attachments")],
                },
              },
            },
          },
        };

        const withImessage = createRequiredImageTool({
          config: cfg,
          agentDir,
          agentChannel: "imessage",
          agentAccountId: "work",
        });

        await expectImageToolExecOk(withImessage, imagePath);
        expect(describeImage).toHaveBeenCalledTimes(1);
      } finally {
        await fs.rm(attachmentRootParent, { recursive: true, force: true });
      }
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

  it("passes web_fetch SSRF policy to remote image references", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("http://198.18.0.153/")) {
        return new Response(Buffer.from(ONE_PIXEL_PNG_B64, "base64"), {
          headers: { "content-type": "image/png" },
        });
      }
      return new Response(
        JSON.stringify({ content: "ok", base_resp: { status_code: 0, status_msg: "" } }),
      );
    });
    global.fetch = withFetchPreconnect(fetch);
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");

    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        ...createMinimaxImageConfig(),
        tools: { web: { fetch: { ssrfPolicy: { allowRfc2544BenchmarkRange: true } } } },
      };
      const tool = createRequiredImageTool({ config: cfg, agentDir });

      await expectImageToolExecOk(tool, "http://198.18.0.153/reference.png");
      const [input, init] = fetchCallAt(fetch, 0);
      expect(input).toBe("http://198.18.0.153/reference.png");
      expect(typeof init).toBe("object");
    });
  });

  it("passes the shared remote read idle timeout when loading remote image references", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ content: "ok", base_resp: { status_code: 0, status_msg: "" } }),
        ),
    );
    global.fetch = withFetchPreconnect(fetch);
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
    const loadWebMedia = vi.fn(async () => ({
      buffer: Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
      contentType: "image/png",
      kind: "image" as const,
    }));
    installImageUnderstandingProviderDeps([minimaxProvider, moonshotProvider], {
      loadImageWebMediaRuntime: async () => ({
        loadWebMedia,
        optimizeImageBufferForWebMedia: async ({ buffer, contentType, fileName }) => ({
          buffer,
          contentType: contentType ?? "image/png",
          kind: "image",
          fileName,
        }),
      }),
    });

    await withTempAgentDir(async (agentDir) => {
      const tool = createRequiredImageTool({
        config: createMinimaxImageConfig(),
        agentDir,
      });

      await expectImageToolExecOk(tool, "https://example.test/reference.png");

      expect(loadWebMedia).toHaveBeenCalledTimes(1);
      const [, options] = fetchCallAt(loadWebMedia, 0);
      expect((options as { readIdleTimeoutMs?: number }).readIdleTimeoutMs).toBe(120_000);
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

  it("applies workspace-only policy to image paths in sandbox mode", async () => {
    await withTempSandboxState(async ({ agentDir, sandboxRoot }) => {
      await fs.writeFile(
        path.join(agentDir, "secret.png"),
        Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
      );
      const sandbox = createUnsafeMountedSandbox({ sandboxRoot, agentRoot: agentDir });
      const bridge = sandbox.fsBridge;
      if (!bridge) {
        throw new Error("expected unsafe sandbox filesystem bridge");
      }
      const fetch = stubMinimaxOkFetch();
      const imageTool = createRequiredImageTool({
        config: createMinimaxImageConfig(),
        agentDir,
        workspaceDir: sandboxRoot,
        sandbox: { root: sandboxRoot, bridge },
        fsPolicy: { workspaceOnly: true },
      });
      await expect(
        imageTool.execute("t1", {
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
    const out = testing.decodeDataUrl(`data:image/png;base64,${pngB64}`);
    expect(out.kind).toBe("image");
    expect(out.mimeType).toBe("image/png");
    expect(out.buffer).toEqual(Buffer.from(pngB64, "base64"));
  });

  it("rejects non-image data URLs", () => {
    expect(() => testing.decodeDataUrl("data:text/plain;base64,SGVsbG8=")).toThrow(
      /Unsupported data URL type/i,
    );
  });

  it("rejects oversized data URLs before decoding", () => {
    const oversizedBase64 = "A".repeat(16);
    const dataUrl = `data:image/png;base64,${oversizedBase64}`;
    const bufferFromSpy = vi.spyOn(Buffer, "from");

    try {
      expect(() => testing.decodeDataUrl(dataUrl, { maxBytes: 4 })).toThrow(/size limit/i);
      expect(bufferFromSpy).not.toHaveBeenCalledWith(oversizedBase64, "base64");
    } finally {
      bufferFromSpy.mockRestore();
    }
  });

  it("applies model image maxBytes to data URLs", async () => {
    await withTempAgentDir(async (agentDir) => {
      const model = {
        ...makeModelDefinition("tiny-vision", ["text", "image"]),
        mediaInput: { image: { maxBytes: 1 } },
      } satisfies ModelDefinitionConfig;
      installImageUnderstandingProviderDeps([], {
        resolveImageCompressionPolicy: async () => ({
          imageCount: 1,
          models: [model.mediaInput.image],
        }),
      });
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            imageModel: { primary: "openai/tiny-vision" },
          },
        },
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              models: [model],
            },
          },
        },
      };
      const tool = createRequiredImageTool({ config: cfg, agentDir });

      await expect(
        tool.execute("t1", {
          prompt: "Describe this image.",
          image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
        }),
      ).rejects.toThrow(/could not be reduced below/i);
    });
  });

  it("downscales data URL images to the resolved model side limit", async () => {
    await withTempAgentDir(async (agentDir) => {
      let observedDimensions: { width: number; height: number } | undefined;
      const model = {
        ...makeModelDefinition("tiny-vision", ["text", "image"]),
        mediaInput: { image: { maxSidePx: 512, preferredSidePx: 512 } },
      } satisfies ModelDefinitionConfig;
      installImageUnderstandingProviderDeps(
        [
          {
            id: "openai",
            capabilities: ["image"],
            describeImage: async (params) => {
              observedDimensions =
                params.mime === "image/png"
                  ? readPngDimensions(params.buffer)
                  : readJpegDimensions(params.buffer);
              return { text: "ok", model: params.model };
            },
          },
        ],
        {
          resolveImageCompressionPolicy: async () => ({
            imageCount: 1,
            models: [model.mediaInput.image],
          }),
        },
      );
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            imageModel: { primary: "openai/tiny-vision" },
            imageQuality: "high",
          },
        },
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              apiKey: "test-key",
              baseUrl: "https://api.openai.com/v1",
              models: [model],
            },
          },
        },
      };
      const tool = createRequiredImageTool({ config: cfg, agentDir });
      const source = createLargeColorBlockPng(1600);
      await expectImageToolExecOk(tool, `data:image/png;base64,${source.toString("base64")}`);

      expect(observedDimensions).toBeDefined();
      if (!observedDimensions) {
        throw new Error("expected observed data URL dimensions");
      }
      expect(Math.max(observedDimensions.width, observedDimensions.height)).toBeLessThanOrEqual(
        512,
      );
    });
  });

  it("applies configured image quality to data URLs without model media metadata", async () => {
    await withTempAgentDir(async (agentDir) => {
      let observedDimensions: { width: number; height: number } | undefined;
      installImageUnderstandingProviderStubs({
        id: "openai",
        capabilities: ["image"],
        describeImage: async (params) => {
          observedDimensions =
            params.mime === "image/png"
              ? readPngDimensions(params.buffer)
              : readJpegDimensions(params.buffer);
          return { text: "ok", model: params.model };
        },
      });
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            imageModel: { primary: "openai/plain-vision" },
            imageQuality: "efficient",
          },
        },
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              apiKey: "test-key",
              baseUrl: "https://api.openai.com/v1",
              models: [makeModelDefinition("plain-vision", ["text", "image"])],
            },
          },
        },
      };
      const tool = createRequiredImageTool({ config: cfg, agentDir });
      const source = createLargeColorBlockPng(1600);
      await expectImageToolExecOk(tool, `data:image/png;base64,${source.toString("base64")}`);

      expect(observedDimensions).toBeDefined();
      if (!observedDimensions) {
        throw new Error("expected observed data URL dimensions");
      }
      expect(Math.max(observedDimensions.width, observedDimensions.height)).toBeLessThanOrEqual(
        1280,
      );
    });
  });
});

describe("image tool MiniMax VLM routing", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    installImageUnderstandingProviderStubs(minimaxProvider);
  });

  afterEach(() => {
    global.fetch = priorFetch;
    imageProviderHarness.reset();
    testing.setProviderDepsForTest();
  });

  async function createMinimaxVlmFixture(baseResp: { status_code: number; status_msg: string }) {
    const fetchMock = stubMinimaxFetch(baseResp, baseResp.status_code === 0 ? "ok" : "");

    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-minimax-vlm-"));
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
    const cfg = createMinimaxImageConfig();
    const tool = createRequiredImageTool({ config: cfg, agentDir });
    return { fetch: fetchMock, tool };
  }

  it("accepts image for single-image requests and calls minimaxUnderstandImage", async () => {
    const { fetch, tool } = await createMinimaxVlmFixture({ status_code: 0, status_msg: "" });

    const res = await tool.execute("t1", {
      prompt: "Describe the image.",
      image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const callArgs = fetch.mock.calls[0]?.[0] as {
      apiKey?: string;
      prompt?: string;
      imageDataUrl?: string;
      provider?: string;
      modelBaseUrl?: string;
    };
    expect(callArgs?.apiKey).toBe("minimax-test");
    expect(callArgs?.prompt).toBe("Describe the image.");
    expect(callArgs?.imageDataUrl).toContain("data:image/png;base64,");

    const text = res.content?.find((b) => b.type === "text")?.text ?? "";
    expect(text).toBe("ok");
  });

  it("accepts images[] for multi-image requests", async () => {
    const { fetch, tool } = await createMinimaxVlmFixture({ status_code: 0, status_msg: "" });
    const secondPngB64 = createLargeColorBlockPng(2).toString("base64");

    const res = await tool.execute("t1", {
      prompt: "Compare these images.",
      images: [
        `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
        `data:image/png;base64,${secondPngB64}`,
      ],
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
    const secondPngB64 = createLargeColorBlockPng(2).toString("base64");

    const deduped = await tool.execute("t1", {
      prompt: "Compare these images.",
      image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      images: [
        `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
        `data:image/png;base64,${secondPngB64}`,
        `data:image/png;base64,${secondPngB64}`,
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
      image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      images: [`data:image/gif;base64,${ONE_PIXEL_GIF_B64}`],
      maxImages: 1,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const tooManyDetails = tooMany.details as
      | {
          error?: string;
          count?: number;
          max?: number;
        }
      | undefined;
    expect(tooManyDetails?.error).toBe("too_many_images");
    expect(tooManyDetails?.count).toBe(2);
    expect(tooManyDetails?.max).toBe(1);
  });

  it("rejects invalid image cap values before loading images", async () => {
    const { fetch, tool } = await createMinimaxVlmFixture({ status_code: 0, status_msg: "" });

    await expect(
      tool.execute("t1", {
        prompt: "Compare these images.",
        image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
        maxImages: 1.5,
      }),
    ).rejects.toThrow("maxImages must be a positive integer");

    await expect(
      tool.execute("t2", {
        prompt: "Compare these images.",
        image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
        maxBytesMb: 0,
      }),
    ).rejects.toThrow("maxBytesMb must be greater than 0");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts string image caps through shared numeric readers", async () => {
    const { fetch, tool } = await createMinimaxVlmFixture({ status_code: 0, status_msg: "" });

    await tool.execute("t1", {
      prompt: "Describe this image.",
      image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      maxImages: "1",
      maxBytesMb: "1",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces MiniMax API errors from /v1/coding_plan/vlm", async () => {
    const { tool } = await createMinimaxVlmFixture({ status_code: 1004, status_msg: "bad key" });

    await expect(
      tool.execute("t1", {
        prompt: "Describe the image.",
        image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      }),
    ).rejects.toThrow(/MiniMax VLM API error/i);
  });
});

describe("image tool managed inbound media", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
    imageProviderHarness.reset();
    testing.setProviderDepsForTest();
  });

  async function withManagedInboundPng(
    run: (params: { stateDir: string; mediaId: string; mediaPath: string }) => Promise<void>,
  ) {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-managed-inbound-"));
    const inboundDir = path.join(stateDir, "media", "inbound");
    const mediaId = "claim-check-test.png";
    const mediaPath = path.join(inboundDir, mediaId);
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(mediaPath, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await run({ stateDir, mediaId, mediaPath });
      });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  }

  it("resolves media://inbound refs", async () => {
    await withManagedInboundPng(async ({ stateDir, mediaId }) => {
      installImageUnderstandingProviderStubs(minimaxProvider);
      const fetch = stubMinimaxOkFetch();
      const workspaceDir = path.join(stateDir, "workspace-agent");
      await fs.mkdir(workspaceDir, { recursive: true });
      await withTempAgentDir(async (agentDir) => {
        const tool = createRequiredImageTool({
          config: createMinimaxImageConfig(),
          agentDir,
          workspaceDir,
          fsPolicy: { workspaceOnly: true },
        });

        await expectImageToolExecOk(tool, `media://inbound/${mediaId}`);
        expect(fetch).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("allows managed inbound absolute paths when workspaceOnly is enabled", async () => {
    await withManagedInboundPng(async ({ mediaPath }) => {
      installImageUnderstandingProviderStubs(minimaxProvider);
      const fetch = stubMinimaxOkFetch();
      await withTempAgentDir(async (agentDir) => {
        const tool = createRequiredImageTool({
          config: createMinimaxImageConfig(),
          agentDir,
          fsPolicy: { workspaceOnly: true },
        });

        await expectImageToolExecOk(tool, mediaPath);
        expect(fetch).toHaveBeenCalledTimes(1);
      });
    });
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
    expect(testing.resolveImageToolMaxTokens(maxOutputTokens)).toBe(expected);
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
      testing.coerceImageAssistantText({
        provider: "openai",
        model: "gpt-5.4-mini",
        message,
      }),
    ).toThrow(expectedError);
  });

  it("returns trimmed text from image-model responses", () => {
    const text = testing.coerceImageAssistantText({
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
      expect(testing.hasImageReasoningOnlyResponse(message as never)).toBe(true);
      expect(() =>
        testing.coerceImageAssistantText({
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
      expect(testing.hasImageReasoningOnlyResponse(message as never)).toBe(true);
      expect(() =>
        testing.coerceImageAssistantText({
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

    expect(testing.hasImageReasoningOnlyResponse(message as never)).toBe(true);
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

    expect(testing.hasImageReasoningOnlyResponse(message as never)).toBe(false);
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

    expect(testing.hasImageReasoningOnlyResponse(message as never)).toBe(true);
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

    expect(testing.hasImageReasoningOnlyResponse(message as never)).toBe(false);
  });
});

describe("image compression policy", () => {
  const cfgWithImageModelMetadata = {
    agents: {
      defaults: {
        imageQuality: "high",
      },
    },
    models: {
      providers: {
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          api: "anthropic-messages",
          models: [
            {
              id: "claude-opus-4-7",
              name: "Claude Opus 4.7",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 1_000_000,
              maxTokens: 64_000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              mediaInput: {
                image: { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
              },
            },
            {
              id: "claude-opus-4-6",
              name: "Claude Opus 4.6",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 1_000_000,
              maxTokens: 64_000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              mediaInput: {
                image: { maxSidePx: 1568, preferredSidePx: 1568, tokenMode: "provider" },
              },
            },
          ],
        },
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [
            {
              id: "gpt-5.5",
              name: "GPT-5.5",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 272_000,
              maxTokens: 128_000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              mediaInput: {
                image: { maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" },
              },
            },
          ],
        },
      },
    },
  } satisfies OpenClawConfig;

  beforeEach(() => {
    installImageUnderstandingProviderStubs();
  });

  afterEach(() => {
    imageProviderHarness.reset();
    testing.setProviderDepsForTest();
  });

  it("derives model metadata, quality preference, and image count from config", async () => {
    const cfg = {
      ...cfgWithImageModelMetadata,
    } satisfies OpenClawConfig;

    await expect(
      testing.resolveImageCompressionPolicy({
        cfg,
        imageModelConfig: { primary: "anthropic/claude-opus-4-7" },
        imageCount: 2,
      }),
    ).resolves.toEqual({
      quality: "high",
      imageCount: 2,
      models: [{ maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" }],
    });
  });

  it("keeps unset image quality as adaptive auto behavior and includes fallback models", async () => {
    const { agents: _agents, ...cfg } = cfgWithImageModelMetadata;
    await expect(
      testing.resolveImageCompressionPolicy({
        cfg,
        imageModelConfig: {
          primary: "openai/gpt-5.5",
          fallbacks: ["anthropic/claude-opus-4-6", "unknown/custom-image"],
        },
        imageCount: 1,
      }),
    ).resolves.toEqual({
      imageCount: 1,
      models: [
        { maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" },
        { maxSidePx: 1568, preferredSidePx: 1568, tokenMode: "provider" },
        {},
      ],
    });
  });

  it("uses bundled Anthropic media limits without runtime provider hooks", async () => {
    await expect(
      testing.resolveImageCompressionPolicy({
        cfg: {},
        imageModelConfig: {
          primary: "anthropic/claude-opus-4-7",
          fallbacks: ["anthropic/claude-sonnet-4-6"],
        },
        imageCount: 1,
      }),
    ).resolves.toEqual({
      imageCount: 1,
      models: [
        { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
        { maxSidePx: 1568, preferredSidePx: 1568, tokenMode: "provider" },
      ],
    });
  });

  it("keeps runtime Anthropic media limits for dated model variants", async () => {
    testing.setProviderDepsForTest({
      resolveModelAsync: async (_provider, model) => ({
        model: {
          mediaInput: {
            image: model.includes("opus")
              ? { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" }
              : { maxSidePx: 1568, preferredSidePx: 1568, tokenMode: "provider" },
          },
        } as never,
        authStorage: {} as never,
        modelRegistry: {} as never,
      }),
    });
    try {
      await expect(
        testing.resolveImageCompressionPolicy({
          cfg: {},
          imageModelConfig: {
            primary: "anthropic/claude-opus-4.7-20260219",
            fallbacks: ["anthropic/claude-sonnet-4.6-20260219"],
          },
          imageCount: 1,
        }),
      ).resolves.toEqual({
        imageCount: 1,
        models: [
          { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
          { maxSidePx: 1568, preferredSidePx: 1568, tokenMode: "provider" },
        ],
      });
    } finally {
      testing.setProviderDepsForTest();
    }
  });

  it("merges partial configured Anthropic media policy with runtime side limits", async () => {
    testing.setProviderDepsForTest({
      resolveModelAsync: async (_provider, _model, _agentDir, _cfg, options) => ({
        model: {
          mediaInput: {
            image: options?.skipProviderRuntimeHooks
              ? { maxBytes: 1_000_000 }
              : { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
          },
        } as never,
        authStorage: {} as never,
        modelRegistry: {} as never,
      }),
    });
    try {
      await expect(
        testing.resolveImageCompressionPolicy({
          cfg: {
            models: {
              providers: {
                anthropic: {
                  baseUrl: "https://api.anthropic.com",
                  api: "anthropic-messages",
                  models: [
                    {
                      id: "claude-opus-4.7-20260219",
                      name: "Claude Opus 4.7 dated",
                      reasoning: true,
                      input: ["text", "image"],
                      contextWindow: 200_000,
                      maxTokens: 64_000,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      mediaInput: { image: { maxBytes: 1_000_000 } },
                    },
                  ],
                },
              },
            },
          } satisfies OpenClawConfig,
          imageModelConfig: {
            primary: "anthropic/claude-opus-4.7-20260219",
          },
          imageCount: 1,
        }),
      ).resolves.toEqual({
        imageCount: 1,
        models: [
          { maxBytes: 1_000_000, maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
        ],
      });
    } finally {
      testing.setProviderDepsForTest();
    }
  });

  it("uses a model override as the compression candidate", async () => {
    await expect(
      testing.resolveImageCompressionPolicy({
        cfg: cfgWithImageModelMetadata,
        imageModelConfig: {
          primary: "openai/gpt-5.5",
          fallbacks: ["anthropic/claude-opus-4-6"],
        },
        modelOverride: "anthropic/claude-opus-4-6",
        imageCount: 1,
      }),
    ).resolves.toMatchObject({
      models: [{ maxSidePx: 1568, preferredSidePx: 1568, tokenMode: "provider" }],
    });
  });

  it("resolves providerless overrides before reading compression metadata", async () => {
    await expect(
      testing.resolveImageCompressionPolicy({
        cfg: cfgWithImageModelMetadata,
        imageModelConfig: {
          primary: "anthropic/claude-opus-4-6",
        },
        modelOverride: "gpt-5.5",
        imageCount: 1,
      }),
    ).resolves.toMatchObject({
      models: [{ maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" }],
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
