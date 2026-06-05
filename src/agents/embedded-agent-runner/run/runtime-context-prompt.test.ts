// Runtime-context prompt tests keep hidden OpenClaw context separate from the
// user-visible prompt while preserving model-only hook additions.
import { describe, expect, it } from "vitest";
import {
  buildCurrentInboundPrompt,
  buildCurrentInboundPromptContextPrefix,
  buildRuntimeContextCustomMessage,
  buildRuntimeContextSystemContext,
  resolveRuntimeContextPromptParts,
} from "./runtime-context-prompt.js";

describe("runtime context prompt submission", () => {
  it("keeps unchanged prompts as a normal user prompt", () => {
    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: "visible ask",
        transcriptPrompt: "visible ask",
      }),
    ).toEqual({ prompt: "visible ask" });
  });

  it("moves hidden runtime context out of the visible prompt", () => {
    // Hidden context is provider input, not user-authored transcript text; it
    // must be split before persistence and display.
    const effectivePrompt = [
      "visible ask",
      "",
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "secret runtime context",
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ].join("\n");

    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt,
        transcriptPrompt: "visible ask",
      }),
    ).toEqual({
      prompt: "visible ask",
      runtimeContext:
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret runtime context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    });
  });

  it("keeps prompt-local additions in the model prompt", () => {
    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: ["runtime prefix", "", "visible ask", "", "retry instruction"].join("\n"),
        transcriptPrompt: "visible ask",
        modelPrompt: ["runtime prefix", "", "visible ask", "", "retry instruction"].join("\n"),
      }),
    ).toEqual({
      prompt: "visible ask",
      modelPrompt: "runtime prefix\n\nvisible ask\n\nretry instruction",
    });
  });

  it("preserves unsplit prompt whitespace", () => {
    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: "  keep literal whitespace  ",
      }),
    ).toEqual({
      prompt: "  keep literal whitespace  ",
    });
  });

  it("keeps no-transcript prompt-local additions in the model prompt", () => {
    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: "visible ask",
        modelPrompt: ["runtime prefix", "", "visible ask", "", "retry instruction"].join("\n"),
      }),
    ).toEqual({
      prompt: "visible ask",
      modelPrompt: "runtime prefix\n\nvisible ask\n\nretry instruction",
    });
  });

  it("keeps hidden runtime context separate from prompt-local additions", () => {
    const prompt = ["runtime prefix", "", "visible ask", "", "retry instruction"].join("\n");
    const effectivePrompt = [
      prompt,
      "",
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "secret runtime context",
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ].join("\n");

    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt,
        transcriptPrompt: "visible ask",
        modelPrompt: effectivePrompt,
      }),
    ).toEqual({
      prompt: "visible ask",
      modelPrompt: prompt,
      runtimeContext:
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret runtime context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    });
  });

  it("does not extract no-transcript delimiter text", () => {
    const effectivePrompt = [
      "visible ask",
      "",
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "secret runtime context",
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ].join("\n");

    expect(resolveRuntimeContextPromptParts({ effectivePrompt })).toEqual({
      prompt: effectivePrompt,
    });
  });

  it("extracts multiple hidden runtime context blocks", () => {
    const effectivePrompt = [
      "runtime prefix",
      "",
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "first secret",
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      "",
      "visible ask",
      "",
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "second secret",
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      "",
      "retry instruction",
    ].join("\n");

    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt,
        transcriptPrompt: "visible ask",
        modelPrompt: effectivePrompt,
      }),
    ).toEqual({
      prompt: "visible ask",
      modelPrompt: "runtime prefix\n\nvisible ask\n\nretry instruction",
      runtimeContext: [
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nfirst secret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        "",
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecond secret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      ].join("\n"),
    });
  });

  it("ignores repeated inline marker mentions without recursive stack growth", () => {
    // Marker-like text in normal prompt lines should stay literal and must not
    // trigger recursive delimiter scanning.
    const inlineMarkers = Array.from(
      { length: 250 },
      () => "inline <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> marker",
    ).join("\n");
    const effectivePrompt = [
      inlineMarkers,
      "",
      "visible ask",
      "",
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "secret runtime context",
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ].join("\n");

    const parts = resolveRuntimeContextPromptParts({
      effectivePrompt,
      transcriptPrompt: "visible ask",
      modelPrompt: effectivePrompt,
    });

    expect(parts.prompt).toContain("visible ask");
    expect(parts.modelPrompt).toContain("inline <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> marker");
    expect(parts.modelPrompt).toContain("visible ask");
    expect(parts.modelPrompt).not.toContain("secret runtime context");
    expect(parts.prompt).not.toContain("secret runtime context");
    expect(parts.runtimeContext).toBe(
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret runtime context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    );
  });

  it("fails closed for unterminated hidden runtime context blocks", () => {
    // Unterminated internal context is ambiguous; keep only the known transcript
    // prompt rather than leaking partial hidden content.
    const effectivePrompt = [
      "visible ask",
      "",
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "secret runtime context",
      "",
      "still secret",
    ].join("\n");

    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt,
        transcriptPrompt: "visible ask",
        modelPrompt: effectivePrompt,
      }),
    ).toEqual({
      prompt: "visible ask",
    });
  });

  it("uses a marker prompt for runtime-only events", () => {
    const parts = resolveRuntimeContextPromptParts({
      effectivePrompt: "internal event",
      transcriptPrompt: "",
    });

    expect(parts).toEqual({
      prompt: "Continue the OpenClaw runtime event.",
      runtimeContext: "internal event",
      runtimeOnly: true,
      runtimeSystemContext: [
        "OpenClaw runtime event.",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "internal event",
      ].join("\n"),
    });
  });

  it("keeps runtime-only hook context in the model prompt", () => {
    const parts = resolveRuntimeContextPromptParts({
      effectivePrompt: "internal event",
      transcriptPrompt: "",
      modelPrompt: ["dynamic hook context", "", "internal event", "", "dynamic hook tail"].join(
        "\n",
      ),
    });

    expect(parts).toEqual({
      prompt: "Continue the OpenClaw runtime event.",
      modelPrompt: "dynamic hook context\n\ninternal event\n\ndynamic hook tail",
      runtimeContext: "internal event",
      runtimeOnly: true,
      runtimeSystemContext: [
        "OpenClaw runtime event.",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "internal event",
      ].join("\n"),
    });
  });

  it("submits empty-transcript model prompts when persistence is suppressed separately", () => {
    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: "[OpenClaw room event]",
        transcriptPrompt: "",
        emptyTranscriptMode: "model-prompt",
      }),
    ).toEqual({
      prompt: "[OpenClaw room event]",
    });
  });

  it("keeps suppressed empty-transcript hook context model-only", () => {
    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: "[OpenClaw room event]",
        transcriptPrompt: "",
        modelPrompt: [
          "dynamic hook context",
          "",
          "[OpenClaw room event]",
          "",
          "dynamic hook tail",
        ].join("\n"),
        emptyTranscriptMode: "model-prompt",
      }),
    ).toEqual({
      prompt: "[OpenClaw room event]",
      modelPrompt: "dynamic hook context\n\n[OpenClaw room event]\n\ndynamic hook tail",
    });
  });

  it("uses current-turn context as prompt-local text", () => {
    expect(
      buildCurrentInboundPromptContextPrefix({
        text: "Conversation info (untrusted metadata):\n```json\n{}\n```",
      }),
    ).toBe("Conversation info (untrusted metadata):\n```json\n{}\n```");
  });

  it("can use compact current-turn context for resumable backends", () => {
    expect(
      buildCurrentInboundPromptContextPrefix(
        {
          text: "Room context:\nAlice: lunch?\n\nCurrent event:\nBob: yes",
          resumableText: "Current event:\nBob: yes",
        },
        { preferResumableText: true },
      ),
    ).toBe("Current event:\nBob: yes");
  });

  it("omits empty current-turn context", () => {
    expect(buildCurrentInboundPromptContextPrefix(undefined)).toBe("");
    expect(buildCurrentInboundPromptContextPrefix({ text: "   " })).toBe("");
  });

  it("joins current-turn context and prompt with the requested separator", () => {
    expect(
      buildCurrentInboundPrompt({
        context: { text: "Current message:\n#34975 obviyus:", promptJoiner: " " },
        prompt: "What do you mean hidden?",
      }),
    ).toBe("Current message:\n#34975 obviyus: What do you mean hidden?");

    expect(
      buildCurrentInboundPrompt({
        context: { text: "Conversation context:" },
        prompt: "visible ask",
      }),
    ).toBe("Conversation context:\n\nvisible ask");

    expect(
      buildCurrentInboundPrompt({
        context: {
          text: "Room context:\nAlice: lunch?\n\nCurrent event:\nBob: yes",
          resumableText: "Current event:\nBob: yes",
        },
        prompt: "[OpenClaw room event]",
        preferResumableText: true,
      }),
    ).toBe("Current event:\nBob: yes\n\n[OpenClaw room event]");
  });

  it("builds runtime context as prompt-local custom context before the current user prompt", () => {
    expect(buildRuntimeContextCustomMessage("secret runtime context")).toMatchObject({
      role: "custom",
      customType: "openclaw.runtime-context",
      content: [
        "OpenClaw runtime context for the immediately preceding user message.",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "secret runtime context",
      ].join("\n"),
      display: false,
      details: { source: "openclaw-runtime-context" },
    });
  });

  it("labels next-turn runtime context only when used as prompt-local system context", () => {
    const systemContext = buildRuntimeContextSystemContext("secret runtime context");

    expect(systemContext).toContain(
      "OpenClaw runtime context for the immediately preceding user message.",
    );
    expect(systemContext).toContain("not user-authored");
    expect(systemContext).toContain("secret runtime context");
  });

  it("labels runtime-only events as system context", async () => {
    const { buildRuntimeEventSystemContext } = await import("./runtime-context-prompt.js");

    expect(buildRuntimeEventSystemContext("internal event")).toContain("OpenClaw runtime event.");
    expect(buildRuntimeEventSystemContext("internal event")).toContain("not user-authored");
  });
});
