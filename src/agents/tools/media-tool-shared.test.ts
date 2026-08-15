// Shared media tool tests cover root separation, provider availability, and
// model-registry normalization for generation/understanding tools.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  hasGenerationToolAvailability,
  isCapabilityProviderConfigured,
  readBooleanToolParam,
  resolveMediaToolInboundRoots,
  resolveCapabilityModelConfigForTool,
  resolveMediaToolReferenceAccess,
  resolveModelFromRegistry,
} from "./media-tool-shared.js";

// Keep media-tool-shared tests focused on root separation; channel-inbound
// tests cover the real bundled contract loader.
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

function normalizeHostPath(value: string): string {
  return path.normalize(path.resolve(value));
}

function createModelRegistryStub(resolve: (provider: string, modelId: string) => unknown): {
  calls: Array<[string, string]>;
  registry: { find: (provider: string, modelId: string) => unknown };
} {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    registry: {
      find(provider, modelId) {
        calls.push([provider, modelId]);
        return resolve(provider, modelId);
      },
    },
  };
}

describe("readBooleanToolParam", () => {
  it("parses booleans and true/false string tokens", () => {
    expect(readBooleanToolParam({ audio: true }, "audio")).toBe(true);
    expect(readBooleanToolParam({ audio: " FALSE " }, "audio")).toBe(false);
    expect(readBooleanToolParam({ audio: "yes" }, "audio")).toBeUndefined();
  });
});

describe("resolveMediaToolLocalRoots", () => {
  it("does not widen default local roots from media sources", async () => {
    const stateDir = path.join("/tmp", "openclaw-media-tool-roots-state");
    const picturesDir =
      process.platform === "win32" ? "C:\\Users\\peter\\Pictures" : "/Users/peter/Pictures";

    const { localRoots } = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      resolveMediaToolReferenceAccess({
        input: path.join(picturesDir, "photo.png"),
        isDataUrl: false,
        workspaceDir: path.join(stateDir, "workspace-agent"),
      }),
    );

    const normalizedRoots = localRoots.map(normalizeHostPath);
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "workspace-agent")));
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "workspace")));
    expect(normalizedRoots).not.toContain(normalizeHostPath(picturesDir));
    expect(normalizedRoots).not.toContain(normalizeHostPath("/"));
  });

  it("keeps channel inbound attachment roots separate from local roots", async () => {
    // Inbound channel roots may include broad chat attachment folders; keep them
    // out of local filesystem allowlists unless the channel context asks.
    const accountRoot = path.join("/tmp", "openclaw-imessage-work");
    const sharedRoot = path.join("/tmp", "openclaw-imessage-shared");
    const cfg = {
      channels: {
        imessage: {
          attachmentRoots: [sharedRoot],
          accounts: {
            work: {
              attachmentRoots: [accountRoot],
            },
          },
        },
      },
    };

    const withoutChannel = await resolveMediaToolReferenceAccess({
      input: "relative/reference.png",
      isDataUrl: false,
      rootOptions: { cfg },
    });
    expect(withoutChannel.localRoots.map(normalizeHostPath)).not.toContain(
      normalizeHostPath(accountRoot),
    );
    expect(withoutChannel.localRoots.map(normalizeHostPath)).not.toContain(
      normalizeHostPath(sharedRoot),
    );
    expect(resolveMediaToolInboundRoots({ cfg })).toEqual([]);

    const withImessage = await resolveMediaToolReferenceAccess({
      input: "relative/reference.png",
      isDataUrl: false,
      rootOptions: { cfg, channelId: "imessage", accountId: "work" },
    });
    expect(withImessage.localRoots.map(normalizeHostPath)).not.toContain(
      normalizeHostPath(accountRoot),
    );
    expect(withImessage.localRoots.map(normalizeHostPath)).not.toContain(
      normalizeHostPath(sharedRoot),
    );
    expect(
      resolveMediaToolInboundRoots({
        cfg,
        channelId: "imessage",
        accountId: "work",
      }).map(normalizeHostPath),
    ).toEqual(
      [accountRoot, sharedRoot, "/Users/*/Library/Messages/Attachments"].map(normalizeHostPath),
    );
  });
});

describe("resolveMediaToolReferenceAccess", () => {
  it("decodes a host-local file URL with Unicode and spaces", async () => {
    const filePath = path.join(process.cwd(), "café reference image.png");

    await expect(
      resolveMediaToolReferenceAccess({
        input: pathToFileURL(filePath).href,
        isDataUrl: false,
        workspaceDir: process.cwd(),
      }),
    ).resolves.toMatchObject({ resolvedPath: filePath });
  });

  it.each(["relative/reference.png", "https://example.com/reference.png", "media://inbound/a.png"])(
    "preserves non-file reference %s",
    async (input) => {
      await expect(
        resolveMediaToolReferenceAccess({
          input,
          isDataUrl: false,
          workspaceDir: process.cwd(),
        }),
      ).resolves.toMatchObject({ resolvedPath: input });
    },
  );

  it("keeps data URLs out of filesystem resolution", async () => {
    await expect(
      resolveMediaToolReferenceAccess({
        input: "data:image/png;base64,cG5n",
        isDataUrl: true,
        workspaceDir: process.cwd(),
      }),
    ).resolves.toMatchObject({ resolvedPath: null });
  });

  it.each([
    ["file://attacker/share.png", /remote hosts/i],
    ["file:///tmp/encoded%2Fseparator.png", /encode path separators/i],
    ["file:///tmp/malformed%ZZ.png", /invalid|malformed/i],
  ])("rejects unsafe or malformed file URL %s", async (input, expected) => {
    await expect(
      resolveMediaToolReferenceAccess({
        input,
        isDataUrl: false,
        workspaceDir: process.cwd(),
      }),
    ).rejects.toThrow(expected);
  });
});

describe("resolveModelFromRegistry", () => {
  it("normalizes provider and model refs before registry lookup", () => {
    const foundModel = { provider: "ollama", id: "qwen3.5:397b-cloud" };
    const { calls, registry } = createModelRegistryStub(() => foundModel);

    const result = resolveModelFromRegistry({
      modelRegistry: registry,
      provider: " OLLAMA ",
      modelId: " qwen3.5:397b-cloud ",
    });

    expect(calls).toEqual([["ollama", "qwen3.5:397b-cloud"]]);
    expect(result).toBe(foundModel);
  });

  it("reports the normalized ref when the registry lookup misses", () => {
    const { registry } = createModelRegistryStub(() => null);

    expect(() =>
      resolveModelFromRegistry({
        modelRegistry: registry,
        provider: " OLLAMA ",
        modelId: " qwen3.5:397b-cloud ",
      }),
    ).toThrow("Unknown model: ollama/qwen3.5:397b-cloud");
  });

  it("falls back to provider-prefixed custom model IDs", () => {
    // Custom providers can store ids with provider prefixes; try both forms so
    // callers can pass the short local model id.
    const foundModel = { provider: "kimchi", id: "kimchi/claude-opus-4-6" };
    const { calls, registry } = createModelRegistryStub((_, modelId) =>
      modelId === "kimchi/claude-opus-4-6" ? foundModel : null,
    );

    const result = resolveModelFromRegistry({
      modelRegistry: registry,
      provider: "kimchi",
      modelId: "claude-opus-4-6",
    });

    expect(calls).toEqual([
      ["kimchi", "claude-opus-4-6"],
      ["kimchi", "kimchi/claude-opus-4-6"],
    ]);
    expect(result).toBe(foundModel);
  }, 180_000);
});

describe("hasGenerationToolAvailability", () => {
  it("accepts config-backed custom provider auth for generation providers", () => {
    const cfg = {
      models: {
        providers: {
          "custom-image": {
            baseUrl: "https://example.com/v1",
            apiKey: "sk-configured", // pragma: allowlist secret
            models: [],
          },
        },
      },
    };

    expect(
      hasGenerationToolAvailability({
        providerKey: "imageGenerationProviders",
        cfg,
        providers: [{ id: "custom-image", defaultModel: "workflow" }],
      }),
    ).toBe(true);
  });

  it("preserves a provider-specific not-configured result over generic config auth", () => {
    const cfg = {
      models: {
        providers: {
          "workflow-image": {
            baseUrl: "https://example.com/v1",
            apiKey: "sk-configured", // pragma: allowlist secret
            models: [],
          },
        },
      },
    };
    const provider = {
      id: "workflow-image",
      defaultModel: "workflow",
      isConfigured: () => false,
    };

    expect(
      isCapabilityProviderConfigured({
        providers: [provider],
        provider,
        cfg,
      }),
    ).toBe(false);
    expect(
      resolveCapabilityModelConfigForTool({
        cfg,
        providers: [provider],
      }),
    ).toBeNull();
  });

  it("allows generation tools for runtime providers configured without auth", () => {
    expect(
      hasGenerationToolAvailability({
        providerKey: "imageGenerationProviders",
        providers: [
          {
            id: "local-image",
            defaultModel: "workflow",
            isConfigured: () => true,
          },
        ],
      }),
    ).toBe(true);
  });

  it("omits generation tools when runtime providers are not configured", () => {
    expect(
      hasGenerationToolAvailability({
        providerKey: "imageGenerationProviders",
        providers: [
          {
            id: "local-image",
            defaultModel: "workflow",
            isConfigured: () => false,
          },
        ],
      }),
    ).toBe(false);
  });

  it("keeps explicit model config sufficient for generation tool registration", () => {
    const loadProviders = vi.fn(() => []);

    expect(
      hasGenerationToolAvailability({
        providerKey: "imageGenerationProviders",
        modelConfig: { primary: "local-image/workflow" },
        providers: loadProviders,
      }),
    ).toBe(true);
    expect(loadProviders).not.toHaveBeenCalled();
  });

  it("checks configured runtime providers against the supplied auth store", () => {
    expect(
      hasGenerationToolAvailability({
        providerKey: "imageGenerationProviders",
        authStore: {
          version: 1,
          profiles: {
            "local-image:default": {
              provider: "local-image",
              type: "api_key",
              key: "test",
            },
          },
        },
        providers: [{ id: "local-image", defaultModel: "workflow" }],
      }),
    ).toBe(true);
  });
});
