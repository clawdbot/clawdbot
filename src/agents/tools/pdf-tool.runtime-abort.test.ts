// PDF runtime-abort coverage keeps prepared-runtime acquisition cancellable and leak-free.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as pdfExtractModule from "../../media/pdf-extract.js";
import * as preparedModelRuntime from "../prepared-model-runtime.js";
import { createPdfToolInfraStub, withTempPdfAgentDir } from "./pdf-tool.test-support.js";

const completeMock = vi.hoisted(() => vi.fn());
const registerProviderStreamForModelMock = vi.hoisted(() => vi.fn());

vi.mock("../../llm/stream.js", async () => {
  const actual = await vi.importActual<typeof import("../../llm/stream.js")>("../../llm/stream.js");
  return { ...actual, complete: completeMock };
});

vi.mock("../provider-stream.js", () => ({
  registerProviderStreamForModel: registerProviderStreamForModelMock,
}));

const { createPdfModelRegistry, stubPdfToolInfra } = createPdfToolInfraStub(completeMock);

describe("PDF tool prepared-runtime cancellation", () => {
  afterEach(() => {
    completeMock.mockReset();
    vi.restoreAllMocks();
  });

  it("rejects before deferred acquisition resolves, then releases the late lease", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, { provider: "anthropic" });
      const cfg = {
        agents: { defaults: { pdfModel: { primary: "anthropic/claude-opus-4-6" } } },
      } as OpenClawConfig;
      const modelRegistry = createPdfModelRegistry(() => ({
        provider: "anthropic",
        api: "anthropic-messages",
        maxTokens: 8192,
        input: ["text", "document"],
      }));
      const release = vi.fn();
      let finishAcquisition!: (
        value: Awaited<ReturnType<typeof preparedModelRuntime.acquireAgentRunPreparedModelRuntime>>,
      ) => void;
      vi.mocked(preparedModelRuntime.acquireAgentRunPreparedModelRuntime).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishAcquisition = resolve;
          }),
      );
      const tool = (await import("./pdf-tool.js")).createPdfTool({ config: cfg, agentDir });
      if (!tool) {
        throw new Error("expected PDF tool");
      }
      const controller = new AbortController();
      const execution = tool.execute(
        "t1",
        { prompt: "summarize", pdf: "/tmp/a.pdf" },
        controller.signal,
      );

      await vi.waitFor(() =>
        expect(preparedModelRuntime.acquireAgentRunPreparedModelRuntime).toHaveBeenCalledOnce(),
      );
      const assertion = expect(execution).rejects.toThrow("PDF runtime cancelled");
      controller.abort(new Error("PDF runtime cancelled"));
      await assertion;
      expect(release).not.toHaveBeenCalled();

      finishAcquisition({
        snapshot: {
          agentDir,
          config: cfg,
          // Cancellation releases this late lease before its stores can be used.
          createStores: () => ({ authStorage: {}, modelRegistry }),
        } as never,
        release,
      });
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
      expect(completeMock).not.toHaveBeenCalled();
    });
  });

  it("releases the runtime when a generic provider ignores cancellation", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const { release } = await stubPdfToolInfra(agentDir, { provider: "openai" });
      vi.spyOn(pdfExtractModule, "extractPdfContent").mockResolvedValue({
        text: "extractable text",
        images: [],
      });
      completeMock.mockImplementationOnce(() => new Promise(() => {}));
      const cfg = {
        agents: { defaults: { pdfModel: { primary: "openai/gpt-5.4-mini" } } },
      } as OpenClawConfig;
      const tool = (await import("./pdf-tool.js")).createPdfTool({ config: cfg, agentDir });
      if (!tool) {
        throw new Error("expected PDF tool");
      }
      const controller = new AbortController();
      const execution = tool.execute(
        "t1",
        { prompt: "summarize", pdf: "/tmp/a.pdf" },
        controller.signal,
      );

      await vi.waitFor(() => expect(completeMock).toHaveBeenCalledOnce());
      const options = completeMock.mock.calls[0]?.[2];
      expect(options?.signal).toBe(controller.signal);
      const assertion = expect(execution).rejects.toThrow("PDF provider cancelled");
      controller.abort(new Error("PDF provider cancelled"));
      await assertion;

      expect(release).toHaveBeenCalledOnce();
    });
  });
});
