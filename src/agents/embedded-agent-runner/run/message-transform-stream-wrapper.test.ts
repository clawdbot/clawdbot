import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import { MAX_VIDEO_BYTES } from "@openclaw/media-core/constants";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDER_CONTEXT_HANDOFF,
  resolveProviderContext,
  type ProviderContext,
  type ProviderStreamOptions,
} from "../../../../packages/ai/src/provider-types.js";
import { attachRuntimePromptMediaFacts } from "../../../media/media-facts.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import type { StreamFn } from "../../runtime/index.js";
import type { SandboxFsBridge } from "../../sandbox/fs-bridge.js";
import { hydratePromptMediaMessages, materializeProviderContext } from "./images.js";
import { wrapStreamFnWithMessageTransform } from "./message-transform-stream-wrapper.js";

const PNG = {
  type: "image" as const,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
  mimeType: "image/png",
};
const MP4 = Buffer.from("0000001c6674797069736f6d0000000069736f6d0000000000000000", "hex");

describe("direct provider context handoff", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("keeps canonical omissions while materializing only exact current runtime facts", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-provider-video-"));
    tempDirs.push(stateDir);
    const env = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const inbound = path.join(stateDir, "media", "inbound");
    await fs.mkdir(inbound, { recursive: true });
    await fs.writeFile(path.join(inbound, "recent.mp4"), MP4);
    await fs.writeFile(path.join(inbound, "steer.mp4"), MP4);

    try {
      const historical = {
        role: "user" as const,
        content: "historical",
        timestamp: 1,
        __openclaw: {
          media: [
            {
              kind: "video",
              contentType: "video/mp4",
              url: "media://inbound/old.mp4",
              hydrationSuppressed: true,
            },
          ],
        },
      };
      const recent = attachRuntimePromptMediaFacts(
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "recent" }, PNG, { ...PNG }],
          timestamp: 2,
          __openclaw: {
            mediaImageBlockFactIndexes: [0, 2],
            mediaImageLayout: {
              slots: [
                { kind: "inline", factIndex: 0 },
                { kind: "inline", factIndex: 2 },
              ],
            },
          },
        },
        [
          { kind: "image", contentType: "image/png" },
          {
            kind: "video",
            contentType: "video/mp4",
            sizeBytes: MP4.length,
            url: "media://inbound/recent.mp4",
            hydrationSuppressed: true,
          },
          { kind: "image", contentType: "image/png" },
        ],
      );
      const steer = attachRuntimePromptMediaFacts(
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "steer" }, { ...PNG }],
          timestamp: 3,
          __openclaw: { mediaImageBlockFactIndexes: [1] },
        },
        [
          {
            kind: "video",
            contentType: "video/mp4",
            sizeBytes: MP4.length,
            url: "media://inbound/steer.mp4",
          },
          { kind: "image", contentType: "image/png" },
        ],
      );
      const canonicalMessages = await hydratePromptMediaMessages([historical, recent, steer], {
        workspaceDir: stateDir,
        model: { input: ["text", "image"] },
      });
      const context = {
        systemPrompt: "system",
        messages: canonicalMessages,
        tools: [],
      } as Parameters<StreamFn>[1];
      const originalJson = JSON.stringify(context);
      const model = {
        id: "canonical",
        provider: "direct",
        api: "test",
        input: ["text", "image"],
      } as Parameters<StreamFn>[0];

      const firstCandidate = vi.fn<StreamFn>((_model, firstContext, options) => {
        expect((options as ProviderStreamOptions)[PROVIDER_CONTEXT_HANDOFF]).toBeUndefined();
        expect(JSON.stringify(firstContext)).toContain("provider does not support native video");
        expect(JSON.stringify(firstContext)).toContain("historical replay is not available yet");
        return createAssistantMessageEventStream();
      });
      void firstCandidate(model, context, {});

      let providerContext: Promise<ProviderContext> | undefined;
      let providerOptions: ProviderStreamOptions | undefined;
      const direct = vi.fn<StreamFn>((_model, canonical, options) => {
        providerOptions = options;
        providerContext = resolveProviderContext(canonical, options);
        return createAssistantMessageEventStream();
      });
      const wrapped = wrapStreamFnWithMessageTransform(
        direct,
        (messages) => messages,
        (input) => materializeProviderContext({ ...input, workspaceDir: stateDir }),
      );
      void wrapped(model, context, {});
      const resolved = await providerContext;

      expect(resolved?.messages[0]?.content).toEqual([
        { type: "text", text: "historical" },
        { type: "text", text: "(video omitted: native historical replay is not available yet)" },
      ]);
      expect(resolved?.messages[1]?.content).toEqual([
        { type: "text", text: "recent" },
        PNG,
        { type: "video", data: MP4.toString("base64"), mimeType: "video/mp4" },
        { ...PNG },
      ]);
      expect(resolved?.messages[2]?.content).toEqual([
        { type: "text", text: "steer" },
        { type: "video", data: MP4.toString("base64"), mimeType: "video/mp4" },
        { ...PNG },
      ]);
      for (const message of resolved?.messages.slice(1) ?? []) {
        expect(message).not.toHaveProperty("__openclaw");
        expect(Object.getOwnPropertySymbols(message)).toEqual([]);
      }
      expect(JSON.stringify(resolved)).not.toContain(stateDir);
      expect(JSON.stringify(context)).toBe(originalJson);
      await expect(providerOptions?.[PROVIDER_CONTEXT_HANDOFF]?.()).rejects.toThrow(
        "already consumed",
      );
    } finally {
      env.restore();
    }
  });

  it("rejects abort after a bounded sandbox read instead of dispatching an omission", async () => {
    let finishRead: ((value: Buffer) => void) | undefined;
    let markReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const bridge = {
      resolvePath: ({ filePath }: { filePath: string }) => ({
        containerPath: filePath,
        relativePath: filePath.replace(/^\//, ""),
      }),
      readFile: vi.fn(async () => {
        markReadStarted?.();
        return await new Promise<Buffer>((resolve) => {
          finishRead = resolve;
        });
      }),
    } as unknown as SandboxFsBridge;
    const controller = new AbortController();
    const current = attachRuntimePromptMediaFacts(
      { role: "user" as const, content: "inspect", timestamp: 1 },
      [{ kind: "video", contentType: "video/mp4", path: "/workspace/clip.mp4" }],
    );
    const resolving = materializeProviderContext({
      context: { systemPrompt: "system", messages: [current], tools: [] },
      signal: controller.signal,
      workspaceDir: "/workspace",
      sandbox: { root: "/workspace", bridge },
    });
    await readStarted;
    controller.abort(new Error("test abort"));
    finishRead?.(MP4);
    await expect(resolving).rejects.toThrow("test abort");
  });

  it("rejects a known over-budget current video before reading it", async () => {
    const readFile = vi.fn();
    const bridge = {
      resolvePath: ({ filePath }: { filePath: string }) => ({
        containerPath: filePath,
        relativePath: filePath.replace(/^\//, ""),
      }),
      readFile,
    } as unknown as SandboxFsBridge;
    const current = attachRuntimePromptMediaFacts(
      { role: "user" as const, content: "inspect", timestamp: 1 },
      [
        {
          kind: "video",
          contentType: "video/mp4",
          path: "/workspace/clip.mp4",
          sizeBytes: MAX_VIDEO_BYTES + 1,
        },
      ],
    );
    const resolved = await materializeProviderContext({
      context: { systemPrompt: "system", messages: [current], tools: [] },
      workspaceDir: "/workspace",
      sandbox: { root: "/workspace", bridge },
    });
    expect(resolved.messages[0]?.content).toContainEqual({
      type: "text",
      text: "(video omitted: native video byte limit exceeded)",
    });
    expect(readFile).not.toHaveBeenCalled();
  });
});
