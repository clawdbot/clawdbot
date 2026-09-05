// Shared media tool tests cover root separation, provider availability, and
// model-registry normalization for generation/understanding tools.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import {
  hasGenerationToolAvailability,
  isCapabilityProviderConfigured,
  loadMediaToolReferences,
  resolveGenerateAction,
  resolveMediaToolInboundRoots,
  resolveCapabilityModelConfigForTool,
  resolveMediaToolReferenceAccess,
  resolveMediaToolSandboxConfig,
} from "./media-tool-shared.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

describe("resolveGenerateAction", () => {
  it.each([
    { name: "absent action", args: {}, expected: "generate" },
    { name: "blank action", args: { action: "   " }, expected: "generate" },
    { name: "non-string action", args: { action: 1 }, expected: "generate" },
    { name: "generate action", args: { action: "generate" }, expected: "generate" },
    { name: "normalized status action", args: { action: " STATUS " }, expected: "status" },
    { name: "list action", args: { action: "list" }, expected: "list" },
  ])("$name", ({ args, expected }) => {
    expect(resolveGenerateAction(args)).toBe(expected);
  });

  it("rejects invalid actions with the ordered contract message", () => {
    expect(() => resolveGenerateAction({ action: "invalid" })).toThrowError(
      /^action must be "generate", "status", or "list"$/,
    );
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

  it.each(["image_generate", "video_generate", "music_generate"] as const)(
    "loads a producer-staged bare handle for %s references",
    async (toolName) => {
      const root = tempDirs.make("openclaw-media-tool-staged-");
      const stagedPath = "media/inbound/openclaw-staged-proof/input-file_upload.png";
      const fullPath = path.join(root, stagedPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(
        fullPath,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2f7z8AAAAASUVORK5CYII=",
          "base64",
        ),
      );
      const sandbox = resolveMediaToolSandboxConfig(
        {
          root,
          bridge: createHostSandboxFsBridge(root),
          stagedMediaPaths: new Map([["file_upload", stagedPath]]),
        },
        true,
      );

      const loaded = await loadMediaToolReferences({
        inputs: ["file_upload"],
        toolName,
        expectedKind: "image",
        sandbox,
        workspaceDir: root,
        maxBytes: 1024,
        mapMedia: (media) => media.buffer,
      });

      expect(loaded).toMatchObject([
        { resolvedInput: "file_upload", rewrittenFrom: "file_upload" },
      ]);
    },
  );
});

describe("resolveCapabilityModelConfigForTool", () => {
  it("does not load runtime providers while resolving an explicitly configured model", () => {
    const listProviders = vi.fn(() => {
      throw new Error("runtime provider list should not run for explicit model config");
    });

    expect(
      resolveCapabilityModelConfigForTool({
        modelConfig: { primary: "qwen/wan2.6-t2v" },
        providers: listProviders,
      }),
    ).toEqual({ primary: "qwen/wan2.6-t2v" });
    expect(listProviders).not.toHaveBeenCalled();
  });

  it("orders auto-detected provider defaults by canonical aliases", () => {
    expect(
      resolveCapabilityModelConfigForTool({
        cfg: {
          agents: { defaults: { model: { primary: "media-alias/gpt-5.5" } } },
        },
        providers: [
          {
            id: "fal",
            defaultModel: "fal-ai/minimax/video-01-live",
            isConfigured: () => true,
          },
          {
            id: "openai",
            aliases: ["media-alias"],
            defaultModel: "sora-2",
            isConfigured: () => true,
          },
        ],
      }),
    ).toEqual({
      primary: "openai/sora-2",
      fallbacks: ["fal/fal-ai/minimax/video-01-live"],
    });
  });
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
