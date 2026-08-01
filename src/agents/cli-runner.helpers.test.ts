/** Tests CLI runner prompt/image/system-prompt helper utilities. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { expectDefined } from "@openclaw/normalization-core";
import type { ImageContent } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { buildInboundMediaNoteProjection } from "../auto-reply/media-note.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { escapeRegExp } from "../shared/regexp.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  buildCliArgs,
  buildClaudeOwnerKey,
  prepareCliPromptImagePayload,
  resolveCliRunQueueKey,
  writeCliSystemPromptFile,
} from "./cli-runner/helpers.js";
import * as promptImageUtils from "./embedded-agent-runner/run/images.js";
import * as toolImages from "./tool-images.js";

describe("prepareCliPromptImagePayload prompt references", () => {
  beforeEach(() => {
    // Restore spies because these helpers use real modules with per-test mocks.
    vi.restoreAllMocks();
  });

  it("returns empty results when the prompt has no image refs", async () => {
    const detectAndLoadPromptImagesSpy = vi.spyOn(promptImageUtils, "detectAndLoadPromptImages");
    const sanitizeImageBlocksSpy = vi.spyOn(toolImages, "sanitizeImageBlocks");

    await expect(
      prepareCliPromptImagePayload({
        backend: { command: "gemini", imagePathScope: "workspace" },
        prompt: "just text",
        workspaceDir: "/workspace",
      }),
    ).resolves.toStrictEqual({ prompt: "just text" });

    expect(detectAndLoadPromptImagesSpy).not.toHaveBeenCalled();
    expect(sanitizeImageBlocksSpy).not.toHaveBeenCalled();
  });

  it("does not hydrate marker or bare paths from recalled memory context", async () => {
    const detectAndLoadPromptImagesSpy = vi.spyOn(promptImageUtils, "detectAndLoadPromptImages");
    const recalledMemory = [
      "<relevant-memories>",
      "1. [fact] stale [media attached: /tmp/some.png] and /tmp/other.png",
      "</relevant-memories>",
    ].join("\n");

    const result = await prepareCliPromptImagePayload({
      backend: { command: "gemini", imagePathScope: "workspace" },
      prompt: `${recalledMemory}\n\ncurrent question`,
      imagePrompt: "current question",
      workspaceDir: "/workspace",
    });

    expect(result.imagePaths).toBeUndefined();
    expect(detectAndLoadPromptImagesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "current question" }),
    );
  });

  it("does not reload OpenClaw CLI image cache paths from prior prompt text", async () => {
    const detectAndLoadPromptImagesSpy = vi.spyOn(promptImageUtils, "detectAndLoadPromptImages");
    const sanitizeImageBlocksSpy = vi.spyOn(toolImages, "sanitizeImageBlocks");

    await expect(
      prepareCliPromptImagePayload({
        backend: { command: "gemini", imagePathScope: "workspace" },
        prompt:
          'Called the Read tool with {"file_path":"/workspace/.openclaw-cli-images/stale.png"}',
        workspaceDir: "/workspace",
      }),
    ).resolves.toStrictEqual({
      prompt: 'Called the Read tool with {"file_path":"/workspace/.openclaw-cli-images/stale.png"}',
    });

    // Cached image paths are generated output, not fresh user references.
    expect(detectAndLoadPromptImagesSpy).not.toHaveBeenCalled();
    expect(sanitizeImageBlocksSpy).not.toHaveBeenCalled();
  });

  it("hydrates explicit prompt refs through the shared image loader", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-ref-image-"),
    );
    const imagePath = path.join(workspaceDir, "photo.png");
    const image = createSolidPngBuffer(1, 1, { r: 255, g: 0, b: 0 });
    await fs.writeFile(imagePath, image);

    try {
      const result = await prepareCliPromptImagePayload({
        backend: { command: "gemini", imagePathScope: "workspace" },
        prompt: `Look at ${imagePath}`,
        workspaceDir,
      });

      expect(result.imagePaths).toHaveLength(1);
      await expect(
        fs.readFile(expectDefined(result.imagePaths?.[0], "image path")),
      ).resolves.toEqual(image);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("dedupes repeated refs and skips failed loads before sanitizing", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-ref-dedupe-"),
    );
    const imagePath = path.join(workspaceDir, "a.png");
    await fs.writeFile(imagePath, createSolidPngBuffer(1, 1, { r: 0, g: 255, b: 0 }));
    try {
      const result = await prepareCliPromptImagePayload({
        backend: { command: "gemini", imagePathScope: "workspace" },
        prompt: `Compare ${imagePath} with ${imagePath} and ${path.join(workspaceDir, "missing.png")}`,
        workspaceDir,
      });

      expect(result.imagePaths).toHaveLength(1);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("surfaces structured image hydration failures", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-structured-failure-"),
    );
    try {
      await expect(
        prepareCliPromptImagePayload({
          backend: { command: "codex" },
          prompt: "describe the attachment",
          workspaceDir,
          media: [{ path: path.join(workspaceDir, "missing.png"), contentType: "image/png" }],
        }),
      ).rejects.toThrow("failed to hydrate 1 structured image attachment");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("surfaces inline sanitization failure when a preceding image fact is suppressed", async () => {
    await expect(
      prepareCliPromptImagePayload({
        backend: { command: "codex" },
        prompt: "already described",
        workspaceDir: "/tmp",
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
      }),
    ).rejects.toThrow("failed to hydrate 1 structured image attachment");
  });

  it("accepts an intentionally non-hydrating remote-only image fact", async () => {
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

    await expect(
      prepareCliPromptImagePayload({
        backend: { command: "codex" },
        prompt: "already described",
        workspaceDir: "/tmp",
        media,
      }),
    ).resolves.toEqual({ prompt: "already described" });
  });
});

describe("buildCliArgs", () => {
  it("keeps passing model overrides on resumed CLI sessions", () => {
    expect(
      buildCliArgs({
        backend: {
          command: "codex",
          modelArg: "--model",
        },
        baseArgs: ["exec", "resume", "thread-123"],
        modelId: "gpt-5.4",
        useResume: true,
      }),
    ).toEqual(["exec", "resume", "thread-123", "--model", "gpt-5.4"]);
  });

  it("strips the internal cache boundary from CLI system prompt args", () => {
    // The boundary is internal prompt-cache metadata and must never reach the
    // downstream CLI as literal text.
    expect(
      buildCliArgs({
        backend: {
          command: "claude",
          systemPromptArg: "--append-system-prompt",
        },
        baseArgs: ["-p"],
        modelId: "claude-sonnet-4-6",
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        useResume: false,
      }),
    ).toEqual(["-p", "--append-system-prompt", "Stable prefix\nDynamic suffix"]);
  });

  it("passes Codex system prompts via a model instructions file config override", () => {
    expect(
      buildCliArgs({
        backend: {
          command: "codex",
          systemPromptFileConfigArg: "-c",
          systemPromptFileConfigKey: "model_instructions_file",
        },
        baseArgs: ["exec", "--json"],
        modelId: "gpt-5.4",
        systemPrompt: "Stable prefix",
        systemPromptFilePath: "/tmp/openclaw/system-prompt.md",
        useResume: false,
      }),
    ).toEqual(["exec", "--json", "-c", 'model_instructions_file="/tmp/openclaw/system-prompt.md"']);
  });

  it("passes Claude system prompts through its file flag", () => {
    expect(
      buildCliArgs({
        backend: {
          command: "claude",
          systemPromptFileArg: "--append-system-prompt-file",
        },
        baseArgs: ["-p"],
        modelId: "claude-sonnet-4-6",
        systemPrompt: "Stable prefix",
        systemPromptFilePath: "/tmp/openclaw/system-prompt.md",
        useResume: false,
      }),
    ).toEqual(["-p", "--append-system-prompt-file", "/tmp/openclaw/system-prompt.md"]);
  });

  it("replaces prompt placeholders before falling back to a trailing positional prompt", () => {
    expect(
      buildCliArgs({
        backend: {
          command: "gemini",
          modelArg: "--model",
        },
        baseArgs: ["--output-format", "json", "--prompt", "{prompt}"],
        modelId: "gemini-3.1-pro-preview",
        promptArg: "describe the image",
        useResume: false,
      }),
    ).toEqual([
      "--output-format",
      "json",
      "--prompt",
      "describe the image",
      "--model",
      "gemini-3.1-pro-preview",
    ]);
  });
});

describe("writeCliImages", () => {
  it("uses stable hashed file paths so repeated image hydration reuses the same path", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-write-images-"),
    );
    const image: ImageContent = {
      type: "image",
      data: "c29tZS1pbWFnZQ==",
      mimeType: "image/png",
    };

    const first = await prepareCliPromptImagePayload({
      backend: { command: "codex" },
      prompt: "",
      workspaceDir,
      images: [image],
    });
    const second = await prepareCliPromptImagePayload({
      backend: { command: "codex" },
      prompt: "",
      workspaceDir,
      images: [image],
    });

    try {
      expect(first.imagePaths).toStrictEqual([
        expect.stringMatching(
          new RegExp(
            `^${escapeRegExp(`${resolvePreferredOpenClawTmpDir()}/openclaw-cli-images/`)}.*\\.png$`,
          ),
        ),
      ]);
      expect(second.imagePaths).toEqual(first.imagePaths);
      await expect(
        fs.readFile(expectDefined(first.imagePaths?.[0], "first image path test invariant")),
      ).resolves.toEqual(Buffer.from(image.data, "base64"));
    } finally {
      await fs.rm(expectDefined(first.imagePaths?.[0], "first image path test invariant"), {
        force: true,
      });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("uses the shared media extension map for image formats beyond the tiny builtin list", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-write-heic-"),
    );
    const image: ImageContent = {
      type: "image",
      data: "aGVpYy1pbWFnZQ==",
      mimeType: "image/heic",
    };

    const written = await prepareCliPromptImagePayload({
      backend: { command: "codex" },
      prompt: "",
      workspaceDir,
      images: [image],
    });

    try {
      expect(written.imagePaths?.[0]).toMatch(/\.heic$/);
    } finally {
      await fs.rm(expectDefined(written.imagePaths?.[0], "written image path test invariant"), {
        force: true,
      });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("sweeps stale workspace-scoped CLI image files", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-write-sweep-"),
    );
    const imageRoot = path.join(workspaceDir, ".openclaw-cli-images");
    const stalePath = path.join(imageRoot, "stale.png");
    const freshPath = path.join(imageRoot, "fresh.png");
    const image: ImageContent = {
      type: "image",
      data: "bmV3LWltYWdl",
      mimeType: "image/png",
    };

    await fs.mkdir(imageRoot, { recursive: true });
    await fs.writeFile(stalePath, "stale");
    await fs.writeFile(freshPath, "fresh");
    const staleTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    await fs.utimes(stalePath, staleTime, staleTime);

    const written = await prepareCliPromptImagePayload({
      backend: { command: "gemini", imagePathScope: "workspace" },
      prompt: "",
      workspaceDir,
      images: [image],
    });

    try {
      await expect(fs.access(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(freshPath, "utf-8")).resolves.toBe("fresh");
      await expect(
        fs.readFile(expectDefined(written.imagePaths?.[0], "written image path test invariant")),
      ).resolves.toEqual(Buffer.from(image.data, "base64"));
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("hydrates prompt media refs into codex image args through the helper seams", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-prompt-image-"),
    );
    const sourceImage = path.join(tempDir, "bb-image.png");
    await fs.writeFile(sourceImage, createSolidPngBuffer(1, 1, { r: 255, g: 255, b: 255 }));

    try {
      const prepared = await prepareCliPromptImagePayload({
        backend: {
          command: "codex",
          imageArg: "--image",
          imageMode: "repeat",
          input: "arg",
        },
        prompt: `[media attached: ${sourceImage} (image/png)]\n\n<media:image>`,
        media: [{ path: sourceImage, contentType: "image/png" }],
        workspaceDir: tempDir,
      });
      const argv = buildCliArgs({
        backend: {
          command: "codex",
          imageArg: "--image",
          imageMode: "repeat",
        },
        baseArgs: ["exec", "--json"],
        modelId: "gpt-5.4",
        imagePaths: prepared.imagePaths,
        promptArg: "describe the attached image",
        useResume: false,
      });

      expect(argv).toStrictEqual([
        "exec",
        "--json",
        "describe the attached image",
        "--image",
        expect.stringContaining("openclaw-cli-images"),
      ]);
      expect(argv[4]).not.toBe(sourceImage);

      await prepared.cleanupImages?.();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("appends hydrated prompt media refs for stdin backends through the helper seams", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-prompt-image-generic-"),
    );
    const sourceImage = path.join(tempDir, "claude-image.png");
    await fs.writeFile(sourceImage, createSolidPngBuffer(1, 1, { r: 255, g: 255, b: 255 }));

    try {
      const prompt = `[media attached: ${sourceImage} (image/png)]\n\n<media:image>`;
      const prepared = await prepareCliPromptImagePayload({
        backend: {
          command: "claude",
          input: "stdin",
        },
        prompt,
        media: [{ path: sourceImage, contentType: "image/png" }],
        workspaceDir: tempDir,
      });
      const promptWithImages = prepared.prompt;

      expect(promptWithImages).toContain("openclaw-cli-images");
      expect(promptWithImages).toContain(prepared.imagePaths?.[0] ?? "");
      expect(promptWithImages.trimEnd().endsWith(prepared.imagePaths?.[0] ?? "")).toBe(true);

      await prepared.cleanupImages?.();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("appends Gemini prompt refs with @-prefixed image paths", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-prompt-image-gemini-"),
    );
    const explicitImage: ImageContent = {
      type: "image",
      data: "c29tZS1leHBsaWNpdC1pbWFnZQ==",
      mimeType: "image/png",
    };

    try {
      const prepared = await prepareCliPromptImagePayload({
        backend: {
          command: "gemini",
          imageArg: "@",
          imagePathScope: "workspace",
          input: "arg",
        },
        prompt: "What is in this image?",
        workspaceDir: tempDir,
        images: [explicitImage],
      });

      expect(prepared.prompt).toContain("\n\n@");
      expect(prepared.prompt).toContain(prepared.imagePaths?.[0] ?? "");
      expect(prepared.prompt.trimEnd().endsWith(`@${prepared.imagePaths?.[0] ?? ""}`)).toBe(true);
      expect(prepared.imagePaths?.[0]?.startsWith(path.join(tempDir, ".openclaw-cli-images"))).toBe(
        true,
      );

      const argv = buildCliArgs({
        backend: {
          command: "gemini",
          imageArg: "@",
          imagePathScope: "workspace",
        },
        baseArgs: ["--output-format", "json", "--prompt", "{prompt}"],
        modelId: "gemini-3.1-pro-preview",
        promptArg: prepared.prompt,
        imagePaths: prepared.imagePaths,
        useResume: false,
      });

      expect(argv).toEqual(["--output-format", "json", "--prompt", prepared.prompt]);

      await prepared.cleanupImages?.();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prefers explicit images over prompt refs through the helper seams", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-explicit-images-"),
    );
    const sourceImage = path.join(tempDir, "ignored-prompt-image.png");
    await fs.writeFile(sourceImage, createSolidPngBuffer(1, 1, { r: 255, g: 255, b: 255 }));
    const explicitImage: ImageContent = {
      type: "image",
      data: "c29tZS1leHBsaWNpdC1pbWFnZQ==",
      mimeType: "image/png",
    };

    try {
      const prepared = await prepareCliPromptImagePayload({
        backend: {
          command: "codex",
          imageArg: "--image",
          imageMode: "repeat",
          input: "arg",
        },
        prompt: `[media attached: ${sourceImage} (image/png)]\n\n<media:image>`,
        workspaceDir: tempDir,
        images: [explicitImage],
      });
      const argv = buildCliArgs({
        backend: {
          command: "codex",
          imageArg: "--image",
          imageMode: "repeat",
        },
        baseArgs: ["exec", "--json"],
        modelId: "gpt-5.4",
        imagePaths: prepared.imagePaths,
        useResume: false,
      });

      expect(argv.reduce((count, arg) => count + (arg === "--image" ? 1 : 0), 0)).toBe(1);
      expect(argv[argv.indexOf("--image") + 1]).toContain("openclaw-cli-images");
      await expect(fs.readFile(prepared.imagePaths?.[0] ?? "")).resolves.toEqual(
        Buffer.from(explicitImage.data, "base64"),
      );

      await prepared.cleanupImages?.();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("merges inline payloads with offloaded refs in attachment order", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-mixed-images-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const inboundDir = path.join(stateDir, "media", "inbound");
    const mediaId = "offloaded.png";
    const historyImagePath = path.join(workspaceDir, "history.png");
    const offloadedImage = createSolidPngBuffer(1, 1, { r: 255, g: 0, b: 0 });
    const inlineImage = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
    const historyImage = createSolidPngBuffer(1, 1, { r: 0, g: 255, b: 0 });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(path.join(inboundDir, mediaId), offloadedImage);
    await fs.writeFile(historyImagePath, historyImage);
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const currentTurn = `compare these\n[media attached: media://inbound/${mediaId}]`;

    try {
      const prepared = await prepareCliPromptImagePayload({
        backend: {
          command: "codex",
          imageArg: "--image",
          imageMode: "repeat",
          input: "arg",
        },
        prompt: `[Earlier history: ${historyImagePath}]\n\n[Retry after failure]\n\n${currentTurn}`,
        imagePrompt: currentTurn,
        workspaceDir,
        images: [
          {
            type: "image",
            data: inlineImage.toString("base64"),
            mimeType: "image/png",
          },
        ],
        imageOrder: ["offloaded", "inline"],
        media: [{ url: `media://inbound/${mediaId}`, contentType: "image/png" }],
      });

      expect(prepared.imagePaths).toHaveLength(2);
      await expect(fs.readFile(prepared.imagePaths?.[0] ?? "")).resolves.toEqual(offloadedImage);
      await expect(fs.readFile(prepared.imagePaths?.[1] ?? "")).resolves.toEqual(inlineImage);

      await prepared.cleanupImages?.();
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("writeCliSystemPromptFile", () => {
  it("writes stripped system prompts to a private temp file", async () => {
    const written = await writeCliSystemPromptFile({
      backend: {
        command: "codex",
        systemPromptFileConfigKey: "model_instructions_file",
      },
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
    });

    try {
      expect(written.filePath).toContain("openclaw-cli-system-prompt-");
      await expect(fs.readFile(written.filePath ?? "", "utf-8")).resolves.toBe(
        "Stable prefix\nDynamic suffix",
      );
    } finally {
      await written.cleanup();
    }
    let err: unknown;
    try {
      await fs.access(written.filePath ?? "");
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
  });
});

describe("resolveCliRunQueueKey", () => {
  it("falls back to workspaceDir when no ownerKey is supplied (legacy)", () => {
    expect(
      resolveCliRunQueueKey({
        backendId: "claude-cli",
        serialize: true,
        runId: "run-1",
        workspaceDir: "/tmp/project-a",
      }),
    ).toBe("claude-cli:workspace:/tmp/project-a");
  });

  it("scopes Claude CLI serialization to the owner identity for fresh runs", () => {
    expect(
      resolveCliRunQueueKey({
        backendId: "claude-cli",
        serialize: true,
        runId: "run-1b",
        workspaceDir: "/tmp/project-a",
        ownerKey: "abcd1234",
      }),
    ).toBe("claude-cli:owner:abcd1234");
  });

  it("scopes Claude CLI serialization to the resumed CLI session id", () => {
    expect(
      resolveCliRunQueueKey({
        backendId: "claude-cli",
        serialize: true,
        runId: "run-2",
        workspaceDir: "/tmp/project-a",
        cliSessionId: "claude-session-123",
      }),
    ).toBe("claude-cli:session:claude-session-123");
  });

  it("prefers cliSessionId over ownerKey when resuming", () => {
    expect(
      resolveCliRunQueueKey({
        backendId: "claude-cli",
        serialize: true,
        runId: "run-2b",
        workspaceDir: "/tmp/project-a",
        cliSessionId: "claude-session-123",
        ownerKey: "abcd1234",
      }),
    ).toBe("claude-cli:session:claude-session-123");
  });

  it("keeps non-Claude backends on the provider lane when serialized", () => {
    expect(
      resolveCliRunQueueKey({
        backendId: "codex-cli",
        serialize: true,
        runId: "run-3",
        workspaceDir: "/tmp/project-a",
        cliSessionId: "thread-123",
      }),
    ).toBe("codex-cli");
  });

  it("disables serialization when serialize=false", () => {
    expect(
      resolveCliRunQueueKey({
        backendId: "claude-cli",
        serialize: false,
        runId: "run-4",
        workspaceDir: "/tmp/project-a",
      }),
    ).toBe("claude-cli:run-4");
  });

  it("keeps Claude live sessions serialized when serialize=false", () => {
    expect(
      resolveCliRunQueueKey({
        backendId: "claude-cli",
        liveSession: "claude-stdio",
        serialize: false,
        runId: "run-live",
        workspaceDir: "/tmp/project-a",
        ownerKey: "abcd1234",
      }),
    ).toBe("claude-cli:owner:abcd1234");
  });

  it("keeps resumed Claude live sessions on the owner lane", () => {
    expect(
      resolveCliRunQueueKey({
        backendId: "claude-cli",
        liveSession: "claude-stdio",
        serialize: true,
        runId: "run-live-resumed",
        workspaceDir: "/tmp/project-a",
        cliSessionId: "claude-session-123",
        ownerKey: "abcd1234",
      }),
    ).toBe("claude-cli:owner:abcd1234");
  });
});

describe("buildClaudeOwnerKey", () => {
  it("is deterministic and distinguishes session keys", () => {
    const base = {
      agentAccountId: "acct-1",
      agentId: "agent-main",
      authProfileId: "profile-a",
      sessionId: "sess-1",
      sessionKey: "key-a",
    };
    const a1 = buildClaudeOwnerKey(base);
    const a2 = buildClaudeOwnerKey(base);
    expect(a1).toBe(a2);
    const b = buildClaudeOwnerKey({ ...base, sessionKey: "key-b" });
    expect(a1).not.toBe(b);
  });

  it("matches the legacy buildClaudeLiveKey hash for a frozen fixture (DO NOT EDIT — splits queue from live-session map)", () => {
    expect(
      buildClaudeOwnerKey({
        agentAccountId: "acct-1",
        agentId: "agent-main",
        authProfileId: "profile-a",
        sessionId: "sess-1",
        sessionKey: "key-a",
      }),
    ).toBe("718b9a6cf473526c3c357883dfc8f1da1cf90b709d9ed38d675b52314abe6800");
  });
});
