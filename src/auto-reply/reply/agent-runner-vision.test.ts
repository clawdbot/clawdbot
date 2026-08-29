import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIResponsesParams } from "../../../packages/ai/src/transports/openai-responses-params-internal.js";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { WorkerTunnelHandle } from "../../gateway/worker-environments/tunnel-contract.js";
import { prepareWorkerTurnMedia } from "../../gateway/worker-environments/worker-turn-media.js";
import type { Model } from "../../llm/types.js";
import { buildEmbeddedRunBaseParams } from "./agent-runner-run-params.js";
import type { FollowupRun } from "./queue.js";

const { loadScopedCatalog } = vi.hoisted(() => ({
  loadScopedCatalog: vi.fn<() => Promise<ModelCatalogEntry[]>>(),
}));
vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: loadScopedCatalog,
}));

const vision = ["text", "image"] as const;
const textOnly = ["text"] as const;
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("ordinary reply model capability at cloud media admission", () => {
  it.each([
    { name: "prepared vision", input: vision, selected: "primary", expected: true },
    { name: "thinking off", input: vision, selected: "primary", expected: true, thinkOff: true },
    { name: "prepared text-only", input: textOnly, selected: "primary", expected: false },
    { name: "text-only fallback", input: vision, selected: "fallback", expected: false },
    { name: "vision fallback", input: textOnly, selected: "fallback", expected: true },
    { name: "reasoning-only metadata", selected: "primary", expected: true, discover: true },
    {
      name: "missing metadata with thinking off",
      selected: "missing",
      expected: true,
      discover: true,
      thinkOff: true,
    },
    {
      name: "configured text-only overrides prepared vision",
      input: vision,
      selected: "primary",
      expected: false,
      configured: true,
    },
  ])(
    "$name preserves selected input through real media and Responses serialization",
    async (testCase) => {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "reply-vision-")));
      roots.push(root);
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", workspace: root }] },
        ...(testCase.configured
          ? {
              models: {
                providers: {
                  acme: {
                    baseUrl: "https://provider.invalid/v1",
                    api: "openai-responses",
                    models: [
                      {
                        id: "primary",
                        name: "Primary",
                        input: ["text"],
                        reasoning: false,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        maxTokens: 1024,
                      },
                    ],
                  },
                },
              },
            }
          : {}),
      };
      const run: FollowupRun["run"] = {
        agentId: "main",
        agentDir: root,
        sessionId: "vision-session",
        sessionFile: "vision-session",
        workspaceDir: root,
        config: cfg,
        provider: "acme",
        model: "primary",
        thinkLevel: testCase.thinkOff ? "off" : "medium",
        timeoutMs: 5_000,
        blockReplyBreak: "text_end",
        thinkingCatalog: [
          { provider: "acme", id: "primary", reasoning: true, input: testCase.input },
          {
            provider: "acme",
            id: "fallback",
            input: testCase.input === vision ? textOnly : vision,
          },
        ],
      };
      loadScopedCatalog.mockResolvedValue([
        { provider: "acme", id: testCase.selected, name: "Selected", input: [...vision] },
      ]);
      const produced = await buildEmbeddedRunBaseParams({
        run,
        provider: "acme",
        model: testCase.selected,
        runId: "vision-run",
        authProfile: {},
      });
      const images = [
        createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 }),
        createSolidPngBuffer(2, 2, { r: 0, g: 0, b: 255 }),
      ].map((data) => ({
        type: "image" as const,
        data: data.toString("base64"),
        mimeType: "image/png",
      }));
      const staged: Buffer[] = [];
      const unexpected = async (): Promise<never> => {
        throw new Error("unexpected workspace operation");
      };
      const tunnel: WorkerTunnelHandle = {
        environmentId: "vision-worker",
        ownerEpoch: 1,
        runWorkspaceCommand: unexpected,
        syncWorkspace: unexpected,
        quiesceWorkspace: unexpected,
        reconcileWorkspace: unexpected,
        stop: unexpected,
        stageAttachments: async ({ localPath }) => {
          for (const entry of await fs.readdir(localPath, {
            recursive: true,
            withFileTypes: true,
          })) {
            if (entry.isFile()) {
              staged.push(await fs.readFile(path.join(entry.parentPath, entry.name)));
            }
          }
        },
      };
      const prepared = await prepareWorkerTurnMedia({
        turn: {
          ...produced,
          sessionId: run.sessionId,
          prompt: "Read the codes in order without tools.",
          images,
        },
        history: [],
        localWorkspaceDir: root,
        remoteWorkspaceDir: "/worker",
        tunnel,
        isAuthorized: () => true,
        signal: new AbortController().signal,
      });
      const expectedImages = testCase.expected ? images : [];
      expect(prepared.images).toEqual(expectedImages);
      const content =
        typeof prepared.prompt === "string"
          ? [{ type: "text" as const, text: prepared.prompt }]
          : prepared.prompt;
      expect(content.filter((part) => part.type === "image")).toEqual(expectedImages);
      for (const image of expectedImages) {
        expect(staged).toContainEqual(Buffer.from(image.data, "base64"));
      }
      const providerModel: Model = {
        id: testCase.selected,
        provider: "acme",
        name: "Selected",
        api: "openai-responses",
        baseUrl: "https://provider.invalid/v1",
        reasoning: false,
        input: testCase.expected ? [...vision] : [...textOnly],
        contextWindow: 8192,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      const payload = buildOpenAIResponsesParams(
        providerModel,
        {
          messages: [{ role: "user", content, timestamp: 1 }],
        },
        {},
      );
      expect(payload.input).toEqual([
        {
          type: "message",
          role: "user",
          content: [
            ...content
              .filter((part) => part.type === "text")
              .map((part) => ({ type: "input_text", text: part.text })),
            ...expectedImages.map((image) => ({
              type: "input_image",
              detail: "auto",
              image_url: `data:${image.mimeType};base64,${image.data}`,
            })),
          ],
        },
      ]);
      expect(loadScopedCatalog).toHaveBeenCalledTimes(testCase.discover ? 1 : 0);
    },
  );
});
