import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { resolveCodexTtsProvenanceTransfer } from "../../plugin-sdk/codex-mcp-projection.js";
import type { AnyAgentTool } from "../tools/common.js";
import { getCoreTtsAttemptResultMediaUrls } from "../tools/tts-tool-result-provenance.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

const ttsMocks = vi.hoisted(() => ({ textToSpeech: vi.fn() }));
vi.mock("../../tts/tts.js", () => ({ textToSpeech: ttsMocks.textToSpeech }));

const fixtures: Array<Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>> = [];

async function createHost(runId: string) {
  const fixture = await createAdmittedHostCapabilityTestFixture({ runId });
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.closeHost();
    fixture.closeAdmission();
  }
  resetAgentRunRegistryForTest();
});

describe("agent harness TTS provenance capability", () => {
  beforeEach(() => {
    ttsMocks.textToSpeech.mockReset();
  });

  it("rejects a retained TTS result after its host attempt closes", async () => {
    const first = await createHost("run-tts-first");
    ttsMocks.textToSpeech.mockResolvedValueOnce({
      success: true,
      audioPath: "/tmp/voice.opus",
      provider: "microsoft",
      audioAsVoice: true,
    });
    const tts = first.hostCapabilities
      .createToolSurface?.({ config: {} })
      .find((tool) => tool.name === "tts");
    const observedResult = await tts?.execute?.("call-tts", { text: "hello" });
    if (!observedResult) {
      throw new Error("expected host-created TTS result");
    }

    const firstResult = {};
    const firstTransfer = resolveCodexTtsProvenanceTransfer(first.hostCapabilities);
    firstTransfer?.(observedResult, firstResult, ["/tmp/voice.opus"]);
    expect(
      getCoreTtsAttemptResultMediaUrls(
        firstResult,
        ["/tmp/voice.opus"],
        first.admittedRunContext.operationalRunInstance,
      ),
    ).toEqual(["/tmp/voice.opus"]);

    first.closeHost();
    expect(() => firstTransfer?.(observedResult, {}, ["/tmp/voice.opus"])).toThrow(
      "no longer active",
    );

    const second = await createHost("run-tts-second");
    const replayTool: AnyAgentTool = {
      name: "replay_tts",
      label: "Replay TTS",
      description: "Return retained TTS output.",
      parameters: Type.Object({}),
      execute: vi.fn(async () => observedResult),
    };
    const reboundReplayTool = second.hostCapabilities.bindToolSurface([replayTool])[0];
    await reboundReplayTool?.execute?.("call-replay", {});
    const replayedResult = {};
    resolveCodexTtsProvenanceTransfer(second.hostCapabilities)?.(observedResult, replayedResult, [
      "/tmp/voice.opus",
    ]);

    expect(
      getCoreTtsAttemptResultMediaUrls(
        replayedResult,
        ["/tmp/voice.opus"],
        second.admittedRunContext.operationalRunInstance,
      ),
    ).toEqual([]);
    expect(
      getCoreTtsAttemptResultMediaUrls(
        firstResult,
        ["/tmp/voice.opus"],
        second.admittedRunContext.operationalRunInstance,
      ),
    ).toEqual([]);
  });
});
