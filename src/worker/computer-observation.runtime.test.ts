import { describe, expect, it, vi } from "vitest";
import {
  projectComputerActResult,
  projectScreenshotResult,
} from "../agents/tools/computer-tool-result.js";
import { createNoisyPngBuffer } from "../plugin-sdk/test-helpers/image-fixtures.js";
import type { ComputerActResult } from "../plugins/computer-use-contract.js";
import { createWorkerTranscriptRuntime } from "./embedded-agent-transcript.runtime.js";

describe("worker computer observation persistence", () => {
  it.each(["screen", "window", "browser"] as const)(
    "commits a large %s observation with pixels only in image content",
    async (kind) => {
      const base64 = createNoisyPngBuffer(512, 512).toString("base64");
      expect(base64.length).toBeGreaterThan(64 * 1024);
      const providerResult = {
        ok: true,
        observation: {
          kind,
          base64,
          format: "png",
          width: 512,
          height: 512,
          observationId: `observation-${kind}`,
        },
      } satisfies ComputerActResult;
      const original = structuredClone(providerResult);
      const target = { nodeId: "desktop-node", screenIndex: 0 };
      const result =
        kind === "screen"
          ? (
              await projectScreenshotResult({
                capture: {
                  base64,
                  displayFrameId: "display-frame",
                  mimeType: "image/png",
                  width: 512,
                  height: 512,
                },
                noteLines: [],
                target,
                action: "screenshot",
                referenceWidth: 1280,
                modelHasVision: true,
              })
            ).result
          : await projectComputerActResult({
              result: providerResult,
              target,
              action: kind === "window" ? "get_window_state" : "get_browser_state",
              referenceWidth: 1280,
              modelHasVision: true,
            });
      const commit = vi.fn(async () => {});
      const transcript = createWorkerTranscriptRuntime({ commit });
      await transcript.withSessionWriteSettlement(() =>
        transcript.onMessagePersisted({
          role: "toolResult",
          toolName: "computer",
          toolCallId: "observe",
          content: result.content,
          details: result.details,
          isError: false,
          timestamp: 1,
        }),
      );

      expect(commit).toHaveBeenCalledOnce();
      expect(commit).toHaveBeenCalledWith([
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({ type: "image", mimeType: "image/png" }),
          ]),
        }),
      ]);
      expect(result.content.filter((part) => part.type === "image")).toHaveLength(1);
      expect(JSON.stringify(result.details).includes(base64)).toBe(false);
      expect(providerResult).toEqual(original);
    },
  );
});
