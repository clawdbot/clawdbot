import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildInboundMediaNoteProjection } from "../../../auto-reply/media-note.js";
import { readRuntimePromptImageFactIndexes } from "../../../media/runtime-prompt-image-provenance.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { prepareEmbeddedAttemptPromptExecution } from "./prompt-image-preparation.js";

async function preparePluginHarnessPromptImages(params: {
  runParams: Parameters<typeof prepareEmbeddedAttemptPromptExecution>[0]["attempt"];
  runtime: {
    agentId?: string;
    workspaceDir: string;
    model: Parameters<typeof prepareEmbeddedAttemptPromptExecution>[0]["attempt"]["model"];
  };
  pluginHarnessOwnsTransport: boolean;
}) {
  if (!params.pluginHarnessOwnsTransport) {
    return {
      images: params.runParams.images,
      imageOrder: params.runParams.imageOrder,
      media: params.runParams.media,
    };
  }
  const result = await prepareEmbeddedAttemptPromptExecution({
    attempt: { ...params.runParams, model: params.runtime.model },
    mediaOwnerAgentId: params.runtime.agentId ?? "main",
    effectiveWorkspace: params.runtime.workspaceDir,
    effectiveFsWorkspaceOnly: false,
    prompt: "",
    skipPromptSubmission: false,
    pluginHarness: true,
  });
  return { images: result.images, imageOrder: result.imageOrder, media: result.media };
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";
describe("plugin harness prompt media", () => {
  it("does not hydrate marker or bare paths from recalled memory context", async () => {
    const recalledMemory = [
      "<relevant-memories>",
      "1. [fact] stale [media attached: /tmp/some.png] and /tmp/other.png",
      "</relevant-memories>",
    ].join("\n");

    await expect(
      preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
          prompt: `${recalledMemory}\n\ncurrent question`,
          sessionId: "session-recalled-memory",
        },
        runtime: {
          model: { input: ["text", "image"] },
          sessionId: "session-recalled-memory",
          workspaceDir: "/tmp",
        },
        pluginHarnessOwnsTransport: true,
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]),
    ).resolves.toEqual({ images: [], imageOrder: undefined, media: undefined });
  });

  it.each([
    {
      name: "filename-only SVG",
      fileName: "diagram.svg",
      contentType: undefined,
      kind: undefined,
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      expectedImages: 0,
    },
    {
      name: "unknown-kind PDF metadata over valid PNG bytes",
      fileName: "report.png",
      contentType: "application/pdf",
      kind: "unknown" as const,
      bytes: Buffer.from(TINY_PNG_BASE64, "base64"),
      expectedImages: 0,
    },
    {
      name: "filename-only authentic PNG",
      fileName: "scan.png",
      contentType: undefined,
      kind: undefined,
      bytes: Buffer.from(TINY_PNG_BASE64, "base64"),
      expectedImages: 1,
    },
    {
      name: "generic-binary authentic PNG",
      fileName: "scan.png",
      contentType: "application/octet-stream",
      kind: undefined,
      bytes: Buffer.from(TINY_PNG_BASE64, "base64"),
      expectedImages: 1,
    },
  ])("applies canonical $name rules at the actual plugin-harness boundary", async (testCase) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-harness-canonical-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const inboundDir = path.join(stateDir, "media", "inbound");
    const imagePath = path.join(inboundDir, testCase.fileName);
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(imagePath, testCase.bytes);
    const media = [{ path: imagePath, contentType: testCase.contentType, kind: testCase.kind }];
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    try {
      const result = await preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
          media,
          sessionId: "session-canonical-media",
          userTurnTranscriptRecorder: {
            message: { role: "user", content: "inspect", __openclaw: { media } },
          },
        },
        runtime: {
          model: { input: ["text", "image"] },
          sessionId: "session-canonical-media",
          workspaceDir,
        },
        pluginHarnessOwnsTransport: true,
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

      expect(result.images ?? []).toHaveLength(testCase.expectedImages);
      if (testCase.expectedImages > 0) {
        expect(result.images?.[0]?.mimeType).toBe("image/png");
      }
      expect(result.media).toBeUndefined();
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("hydrates plugin images and preserves serialized replay order with non-image facts", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-harness-media-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const inboundDir = path.join(stateDir, "media", "inbound");
    const mediaId = "photo.png";
    const imagePath = path.join(inboundDir, mediaId);
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const documentFact = {
      path: path.join(workspaceDir, "misleading.png"),
      contentType: "application/pdf",
      kind: "document" as const,
    };
    const input = {
      runParams: {
        agentId: "main",
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        imageOrder: ["offloaded"],
        media: [documentFact, { url: `media://inbound/${mediaId}`, contentType: "image/png" }],
        sessionId: "session-1",
        userTurnTranscriptRecorder: {
          message: {
            role: "user",
            content: "inspect",
            __openclaw: {
              media: [{ path: imagePath, contentType: "image/png" }, documentFact],
              mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 0 }] },
            },
          },
        },
      },
      runtime: {
        model: { input: ["text", "image"] },
        sessionId: "session-1",
        workspaceDir,
      },
      pluginHarnessOwnsTransport: true,
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0];

    try {
      const result = await preparePluginHarnessPromptImages(input);

      expect(result.images).toEqual([
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
      expect(readRuntimePromptImageFactIndexes(result.images ?? [])).toEqual([0]);
      expect(result.imageOrder).toEqual(["inline"]);
      expect(result.media).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(imagePath);
      expect(structuredClone(result).images).toEqual(result.images);
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("hydrates named-agent workspace images without opening sibling workspaces", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-harness-agent-media-"));
    const workspaceDir = path.join(stateDir, "workspace-arthur");
    const siblingWorkspaceDir = path.join(stateDir, "workspace-merlin");
    const imagePath = path.join(workspaceDir, "media", "inbound", "photo.png");
    const siblingImagePath = path.join(siblingWorkspaceDir, "media", "inbound", "photo.png");
    const image = Buffer.from(TINY_PNG_BASE64, "base64");
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.mkdir(path.dirname(siblingImagePath), { recursive: true });
    await fs.writeFile(imagePath, image);
    await fs.writeFile(siblingImagePath, image);
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const config = {
      agents: {
        entries: {
          arthur: { workspace: workspaceDir },
          merlin: { workspace: siblingWorkspaceDir },
        },
      },
    };

    try {
      const hydrate = (mediaPath: string, sessionId: string) =>
        preparePluginHarnessPromptImages({
          runParams: {
            config,
            media: [{ path: mediaPath, contentType: "image/png" }],
            sessionId,
            sessionKey: `agent:arthur:telegram:direct:${sessionId}`,
          },
          runtime: {
            agentId: "arthur",
            model: { input: ["text", "image"] },
            sessionId,
            workspaceDir,
          },
          pluginHarnessOwnsTransport: true,
        } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

      const result = await hydrate(imagePath, "session-agent-media");

      expect(result.images).toEqual([
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
      await expect(hydrate(siblingImagePath, "session-agent-sibling-media")).rejects.toThrow(
        "failed to hydrate 1 structured image attachment",
      );
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("hydrates named-agent workspace images on the embedded prompt path", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-embedded-agent-media-"));
    const workspaceDir = path.join(stateDir, "workspace-arthur");
    const siblingWorkspaceDir = path.join(stateDir, "workspace-merlin");
    const imagePath = path.join(workspaceDir, "media", "inbound", "photo.png");
    const siblingImagePath = path.join(siblingWorkspaceDir, "media", "inbound", "photo.png");
    const image = Buffer.from(TINY_PNG_BASE64, "base64");
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.mkdir(path.dirname(siblingImagePath), { recursive: true });
    await fs.writeFile(imagePath, image);
    await fs.writeFile(siblingImagePath, image);
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    try {
      const hydrate = (mediaPath: string, sessionId: string) =>
        prepareEmbeddedAttemptPromptExecution({
          attempt: {
            config: {
              agents: {
                entries: {
                  arthur: { workspace: workspaceDir },
                  merlin: { workspace: siblingWorkspaceDir },
                },
              },
            },
            media: [{ path: mediaPath, contentType: "image/png" }],
            model: { input: ["text", "image"] },
            sessionId,
          },
          mediaOwnerAgentId: "arthur",
          effectiveWorkspace: workspaceDir,
          effectiveFsWorkspaceOnly: false,
          prompt: "",
          skipPromptSubmission: false,
        } as unknown as Parameters<typeof prepareEmbeddedAttemptPromptExecution>[0]);

      const owned = await hydrate(imagePath, "session-embedded-media");

      expect(owned.images).toEqual([
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
      expect(owned.failedMediaCount).toBe(0);

      // The embedded path returns before the plugin-harness throw, so a refused
      // sibling read shows up as a failure count rather than a rejection.
      const sibling = await hydrate(siblingImagePath, "session-embedded-sibling-media");

      expect(sibling.images).toEqual([]);
      expect(sibling.failedMediaCount).toBe(1);
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("surfaces a failed image hydration before plugin dispatch", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-harness-failed-media-"));
    try {
      await expect(
        preparePluginHarnessPromptImages({
          runParams: {
            agentId: "main",
            config: { agents: { defaults: { sandbox: { mode: "off" } } } },
            imageOrder: ["offloaded"],
            media: [{ path: path.join(workspaceDir, "missing.png"), contentType: "image/png" }],
            sessionId: "session-failed",
          },
          runtime: {
            model: { input: ["text", "image"] },
            sessionId: "session-failed",
            workspaceDir,
          },
          pluginHarnessOwnsTransport: true,
        } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]),
      ).rejects.toThrow("failed to hydrate 1 structured image attachment");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("delivers readable images when an unresolved attachment is hydration-suppressed", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-harness-mixed-media-"));
    const imagePath = path.join(workspaceDir, "present.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    try {
      const result = await preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
          images: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
          imageOrder: ["inline"],
          media: [
            { path: imagePath, contentType: "image/png" },
            {
              path: path.join(workspaceDir, "missing.png"),
              contentType: "image/png",
              hydrationSuppressed: true,
            },
          ],
          sessionId: "session-mixed",
        },
        runtime: {
          model: { input: ["text", "image"] },
          sessionId: "session-mixed",
          workspaceDir,
        },
        pluginHarnessOwnsTransport: true,
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

      expect(result.images).toEqual([
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
      expect(result.imageOrder).toEqual(["inline"]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("surfaces an unsuppressed identity-less inline fact with no image block", async () => {
    await expect(
      preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
          imageOrder: ["inline"],
          media: [{ kind: "image" }],
          sessionId: "session-missing-inline",
        },
        runtime: {
          model: { input: ["text", "image"] },
          sessionId: "session-missing-inline",
          workspaceDir: "/tmp",
        },
        pluginHarnessOwnsTransport: true,
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]),
    ).rejects.toThrow("failed to hydrate 1 structured image attachment");
  });

  it("surfaces a fact-owned image dropped during host sanitization", async () => {
    await expect(
      preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
          images: [{ type: "image", data: "%%%", mimeType: "image/png" }],
          imageOrder: ["inline"],
          media: [{ kind: "image" }],
          sessionId: "session-sanitize-failed",
        },
        runtime: {
          model: { input: ["text", "image"] },
          sessionId: "session-sanitize-failed",
          workspaceDir: "/tmp",
        },
        pluginHarnessOwnsTransport: true,
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]),
    ).rejects.toThrow("failed to hydrate 1 structured image attachment");
  });

  it("surfaces inline sanitization failure when a preceding plugin image fact is suppressed", async () => {
    await expect(
      preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
          images: [{ type: "image", data: "%%%", mimeType: "image/png" }],
          imageOrder: ["inline"],
          media: [
            {
              path: "/tmp/described-missing.png",
              contentType: "image/png",
              hydrationSuppressed: true,
            },
            { path: "/tmp/inline.png", contentType: "image/png" },
          ],
          sessionId: "session-suppressed-before-inline",
        },
        runtime: {
          model: { input: ["text", "image"] },
          sessionId: "session-suppressed-before-inline",
          workspaceDir: "/tmp",
        },
        pluginHarnessOwnsTransport: true,
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]),
    ).rejects.toThrow("failed to hydrate 1 structured image attachment");
  });

  it("retains an intentionally non-hydrating remote-only image as a type-only fact", async () => {
    const media = buildInboundMediaNoteProjection({
      media: [{ url: "https://example.com/described.png", contentType: "image/png" }],
      MediaUnderstanding: [
        {
          kind: "image.description",
          attachmentIndex: 0,
          text: "already described",
          provider: "test",
        },
      ],
    }).media;
    const result = await preparePluginHarnessPromptImages({
      runParams: {
        agentId: "main",
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        media,
        sessionId: "session-described",
      },
      runtime: {
        model: { input: ["text", "image"] },
        sessionId: "session-described",
        workspaceDir: "/tmp",
      },
      pluginHarnessOwnsTransport: true,
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

    expect(result.images).toEqual([]);
    expect(result.media).toBeUndefined();
  });

  it("retains layout-derived suppression after plugin host materialization", async () => {
    const inlineImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const result = await preparePluginHarnessPromptImages({
      runParams: {
        agentId: "main",
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        images: [inlineImage],
        imageOrder: ["inline"],
        media: [
          { path: "/tmp/described.png", contentType: "image/png" },
          { path: "/tmp/inline.png", contentType: "image/png" },
        ],
        sessionId: "session-layout-suppressed",
        userTurnTranscriptRecorder: {
          message: {
            role: "user",
            content: "compare",
            __openclaw: {
              media: [
                { path: "/tmp/described.png", contentType: "image/png" },
                { path: "/tmp/inline.png", contentType: "image/png" },
              ],
              mediaImageLayout: {
                slots: [{ kind: "inline", factIndex: 1 }],
                suppressedFactIndexes: [0],
              },
            },
          },
        },
      },
      runtime: {
        model: { input: ["text", "image"] },
        sessionId: "session-layout-suppressed",
        workspaceDir: "/tmp",
      },
      pluginHarnessOwnsTransport: true,
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

    expect(result.images).toEqual([inlineImage]);
    expect(result.imageOrder).toEqual(["inline"]);
    expect(result.media).toBeUndefined();
  });

  it("keeps unsupported native images as aligned type-only facts", async () => {
    const media = [
      { path: "/tmp/photo.png", contentType: "image/png" },
      { path: "/tmp/inferred.png", kind: "unknown" as const },
    ];
    const result = await preparePluginHarnessPromptImages({
      runParams: {
        agentId: "main",
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        media,
        sessionId: "session-text-only",
      },
      runtime: {
        model: { input: ["text"] },
        sessionId: "session-text-only",
        workspaceDir: "/tmp",
      },
      pluginHarnessOwnsTransport: true,
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

    expect(result.images).toEqual([]);
    expect(result.media).toBeUndefined();
  });

  it("leaves facts untouched when the native harness owns transport", async () => {
    const media = [{ path: "/tmp/photo.png", contentType: "image/png" }];
    const result = await preparePluginHarnessPromptImages({
      runParams: { media },
      runtime: {},
      pluginHarnessOwnsTransport: false,
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

    expect(result).toEqual({ images: undefined, imageOrder: undefined, media });
  });
});
