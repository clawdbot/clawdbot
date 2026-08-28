import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as pdfExtractModule from "../../media/pdf-extract.js";
import {
  createPdfToolInfraStub,
  resetPdfToolAuthEnv,
  withTempPdfAgentDir,
} from "./pdf-tool.test-support.js";

const completeMock = vi.hoisted(() => vi.fn());
const registerProviderStreamForModelMock = vi.hoisted(() => vi.fn());

vi.mock("../../llm/stream.js", async () => {
  const actual = await vi.importActual<typeof import("../../llm/stream.js")>("../../llm/stream.js");
  return { ...actual, complete: completeMock };
});

vi.mock("../provider-stream.js", () => ({
  registerProviderStreamForModel: registerProviderStreamForModelMock,
}));

const { stubPdfToolInfra } = createPdfToolInfraStub(completeMock);

describe("PDF tool truncation reporting", () => {
  beforeEach(() => {
    resetPdfToolAuthEnv();
    completeMock.mockReset();
    registerProviderStreamForModelMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts later pages and reports a count-limited explicit selection", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, {
        provider: "openai",
        api: "openai-responses",
        input: ["text"],
      });
      const extractSpy = vi.spyOn(pdfExtractModule, "extractPdfContent").mockResolvedValue({
        text: "Extracted content",
        images: [],
      });
      completeMock.mockResolvedValue({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "fallback summary" }],
      });
      const model = "openai/gpt-5.4-mini";
      const config = {
        agents: { defaults: { pdfModel: { primary: model }, pdfMaxPages: 2 } },
      } as OpenClawConfig;
      const { createPdfTool } = await import("./pdf-tool.js");
      const tool = createPdfTool({ config, agentDir });
      if (!tool) {
        throw new Error("expected PDF tool");
      }

      const result = await tool.execute("t1", {
        prompt: "summarize",
        pdf: "/tmp/doc.pdf",
        pages: "21-23",
      });

      expect(extractSpy).toHaveBeenCalledWith(
        expect.objectContaining({ pageNumbers: [21, 22], maxPages: 2 }),
      );
      const context = completeMock.mock.calls[0]?.[1] as {
        messages?: Array<{ content?: Array<{ text?: string }> }>;
      };
      const completionText = context.messages?.[0]?.content
        ?.map((item) => item.text ?? "")
        .join("\n");
      const notice = "[Partial document: requested page selection limited to 2 pages.]";
      expect(completionText).toContain(notice);
      expect(result.content).toEqual([{ type: "text", text: `${notice}\nfallback summary` }]);
    });
  });
});
