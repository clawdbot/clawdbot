import { describe, expect, it } from "vitest";
import {
  opencodeMediaUnderstandingProvider,
  stripOpencodeDisabledResponsesReasoningPayload,
} from "./media-understanding-provider.js";

describe("opencode media understanding provider", () => {
  it("strips disabled Responses reasoning payloads", () => {
    const payload = {
      reasoning: { effort: "none" },
      include: ["reasoning.encrypted_content"],
      store: false,
    };

    stripOpencodeDisabledResponsesReasoningPayload(payload);

    expect(payload).toEqual({
      include: ["reasoning.encrypted_content"],
      store: false,
    });
  });

  it("keeps supported Responses reasoning payloads", () => {
    const payload = {
      reasoning: { effort: "low" },
      store: false,
    };

    stripOpencodeDisabledResponsesReasoningPayload(payload);

    expect(payload).toEqual({
      reasoning: { effort: "low" },
      store: false,
    });
  });

  it("declares OpenCode image understanding support", () => {
    expect(opencodeMediaUnderstandingProvider).toEqual(
      expect.objectContaining({
        id: "opencode",
        capabilities: ["image"],
        defaultModels: { image: "gpt-5-nano" },
        describeImage: expect.any(Function),
        describeImages: expect.any(Function),
      }),
    );
  });
});
