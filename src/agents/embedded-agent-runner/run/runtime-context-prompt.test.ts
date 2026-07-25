// Runtime-context prompt tests keep hidden OpenClaw context separate from the
// user-visible prompt while preserving model-only hook additions.
import { describe, expect, it } from "vitest";
import {
  buildCurrentInboundPrompt,
  buildRuntimeContextCustomMessage,
  resolveRuntimeContextPromptParts,
} from "./runtime-context-prompt.js";

function withModelPromptBuildContext(params: {
  promptBeforeHooks: string;
  transcriptPrompt: string;
  promptBeforeAnnotation?: string;
  prependContext?: string;
  appendContext?: string;
}) {
  return {
    modelPromptBuildContext: {
      promptBeforeHooks: params.promptBeforeHooks,
      transcriptPromptBeforeTransforms: params.transcriptPrompt,
      promptBeforeAnnotation: params.promptBeforeAnnotation ?? params.promptBeforeHooks,
      prependContext: params.prependContext ?? "",
      appendContext: params.appendContext ?? "",
    },
  };
}

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
    const visiblePrompt = "[media attached: /tmp/a.png (image/png)]\nvisible ask";
    const effectivePrompt = [
      visiblePrompt,
      "",
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "secret runtime context",
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ].join("\n");

    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt,
        transcriptPrompt: visiblePrompt,
      }),
    ).toEqual({
      prompt: visiblePrompt,
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

  it("strips system-event prefix from modelPrompt when hooks add prepend context", () => {
    // Regression: before_prompt_build hooks that add prependContext set hasPromptBuildContext=true,
    // causing modelPrompt=effectivePrompt (with system-event prefix). Without this fix the event
    // appeared in both runtimeContext (Message A) and modelPrompt (Message B). #95323
    const systemEvent = "System: [2026-06-20 13:59:51] Slack DM from Alice";
    const userText = "Hello, what can you do?";
    const prependContext = "Hook injected context";
    const queuedBody = [systemEvent, "", userText].join("\n");

    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: queuedBody,
        transcriptPrompt: userText,
        modelPrompt: [prependContext, "", queuedBody].join("\n"),
        ...withModelPromptBuildContext({
          promptBeforeHooks: queuedBody,
          transcriptPrompt: userText,
          prependContext,
        }),
      }),
    ).toEqual({
      prompt: userText,
      modelPrompt: [prependContext, "", userText].join("\n"),
      runtimeContext: systemEvent,
    });
  });

  it("strips system-event prefix from modelPrompt when hooks add append context", () => {
    const systemEvent = "System: [2026-06-20 13:59:51] Slack DM from Alice";
    const userText = "Hello";
    const appendContext = "Hook tail context";
    const queuedBody = [systemEvent, "", userText].join("\n");

    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: queuedBody,
        transcriptPrompt: userText,
        modelPrompt: [queuedBody, "", appendContext].join("\n"),
        ...withModelPromptBuildContext({
          promptBeforeHooks: queuedBody,
          transcriptPrompt: userText,
          appendContext,
        }),
      }),
    ).toEqual({
      prompt: userText,
      modelPrompt: [userText, "", appendContext].join("\n"),
      runtimeContext: systemEvent,
    });
  });

  it("strips hidden prompt context on both sides without removing repeated hook text", () => {
    const systemEvent = "System: [2026-06-20 13:59:51] Slack DM from Alice";
    const userText = "Hello";
    const untrustedContext = "Untrusted channel metadata";
    const hookContext = systemEvent;
    const effectivePrompt = [systemEvent, userText, untrustedContext].join("\n\n");
    const modelPrompt = [hookContext, effectivePrompt, hookContext].join("\n\n");

    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt,
        transcriptPrompt: userText,
        modelPrompt,
        ...withModelPromptBuildContext({
          promptBeforeHooks: effectivePrompt,
          transcriptPrompt: userText,
          prependContext: hookContext,
          appendContext: hookContext,
        }),
      }),
    ).toEqual({
      prompt: userText,
      modelPrompt: [hookContext, userText, hookContext].join("\n\n"),
      runtimeContext: [systemEvent, untrustedContext].join("\n\n"),
    });
  });

  it("anchors hidden-context removal before append hooks that repeat the prompt", () => {
    const systemEvent = "System: [2026-06-20 13:59:51] Slack DM from Alice";
    const userText = "Hello";
    const appendContext = "Hook summary: Hello";

    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: [systemEvent, userText].join("\n\n"),
        transcriptPrompt: userText,
        modelPrompt: [systemEvent, userText, appendContext].join("\n\n"),
        ...withModelPromptBuildContext({
          promptBeforeHooks: [systemEvent, userText].join("\n\n"),
          transcriptPrompt: userText,
          appendContext,
        }),
      }),
    ).toEqual({
      prompt: userText,
      modelPrompt: [userText, appendContext].join("\n\n"),
      runtimeContext: systemEvent,
    });
  });

  it("strips the last matching prompt occurrence when prepend hooks quote the body", () => {
    const systemEvent = "System: [2026-06-20 13:59:51] Slack DM from Alice";
    const userText = "Hello";
    const untrustedContext = "Untrusted channel metadata";
    const effectivePrompt = [systemEvent, userText, untrustedContext].join("\n\n");

    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt,
        transcriptPrompt: userText,
        modelPrompt: [effectivePrompt, effectivePrompt].join("\n\n"),
        ...withModelPromptBuildContext({
          promptBeforeHooks: effectivePrompt,
          transcriptPrompt: userText,
          prependContext: effectivePrompt,
        }),
      }),
    ).toEqual({
      prompt: userText,
      modelPrompt: [effectivePrompt, userText].join("\n\n"),
      runtimeContext: [systemEvent, untrustedContext].join("\n\n"),
    });
  });

  it("strips the active prompt before append hooks that quote the body", () => {
    const systemEvent = "System: [2026-06-20 13:59:51] Slack DM from Alice";
    const userText = "Hello";
    const effectivePrompt = [systemEvent, userText].join("\n\n");

    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt,
        transcriptPrompt: userText,
        modelPrompt: [effectivePrompt, effectivePrompt].join("\n\n"),
        ...withModelPromptBuildContext({
          promptBeforeHooks: effectivePrompt,
          transcriptPrompt: userText,
          appendContext: effectivePrompt,
        }),
      }),
    ).toEqual({
      prompt: userText,
      modelPrompt: [userText, effectivePrompt].join("\n\n"),
      runtimeContext: systemEvent,
    });
  });

  it("normalizes quoted hook prompts before locating the active prompt", () => {
    const systemEvent = "System: [2026-06-20 13:59:51] Slack DM from Alice";
    const userText = "Hello";
    const internalContext = [
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "private runtime note",
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ].join("\n");
    const effectivePrompt = [systemEvent, userText, internalContext].join("\n\n");

    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt,
        transcriptPrompt: userText,
        modelPrompt: [effectivePrompt, effectivePrompt].join("\n\n"),
        ...withModelPromptBuildContext({
          promptBeforeHooks: effectivePrompt,
          transcriptPrompt: userText,
          appendContext: effectivePrompt,
        }),
      }),
    ).toEqual({
      prompt: userText,
      modelPrompt: [userText, systemEvent, userText].join("\n\n"),
      runtimeContext: [systemEvent, internalContext].join("\n\n"),
    });
  });

  it("preserves user prompt edge whitespace while removing hidden context", () => {
    const systemEvent = "System: [2026-06-20 13:59:51] Slack DM from Alice";
    const userText = " leading text ";
    const appendContext = "Hook tail";
    const effectivePrompt = [systemEvent, userText].join("\n\n");

    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt,
        transcriptPrompt: userText,
        modelPrompt: [effectivePrompt, appendContext].join("\n\n"),
        ...withModelPromptBuildContext({
          promptBeforeHooks: effectivePrompt,
          transcriptPrompt: userText,
          appendContext,
        }),
      }),
    ).toEqual({
      prompt: userText,
      modelPrompt: `${userText}\n\n${appendContext}`,
      runtimeContext: systemEvent,
    });
  });

  it("strips hidden context after prompt transforms decorate the active hook body", () => {
    const systemEvent = "System: [2026-06-20 13:59:51] Slack DM from Alice";
    const userText = "Hello";
    const prependContext = "Hook injected context";
    const queuedContext = "[Queued messages while agent was busy]";
    const promptBeforeHooks = [systemEvent, userText].join("\n\n");
    const promptBeforeAnnotation = [queuedContext, promptBeforeHooks].join("\n\n");
    const transcriptPrompt = [queuedContext, userText].join("\n\n");
    const modelPrompt = [queuedContext, prependContext, promptBeforeHooks].join("\n\n");

    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: promptBeforeAnnotation,
        transcriptPrompt,
        modelPrompt,
        ...withModelPromptBuildContext({
          promptBeforeHooks,
          transcriptPrompt: userText,
          promptBeforeAnnotation,
          prependContext,
        }),
      }),
    ).toEqual({
      prompt: transcriptPrompt,
      modelPrompt: [queuedContext, prependContext, userText].join("\n\n"),
      runtimeContext: systemEvent,
    });
  });

  it("keeps outer provenance context ahead of source runtime context", () => {
    const provenance = "[Inter-session message] sourceTool=sessions_send isUser=false";
    const systemEvent = "System: [2026-06-20 13:59:51] Slack DM from Alice";
    const userText = "Hello";
    const promptBeforeHooks = [systemEvent, userText].join("\n\n");
    const prependContext = "Hook injected context";

    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: [provenance, promptBeforeHooks].join("\n"),
        transcriptPrompt: userText,
        modelPrompt: [prependContext, promptBeforeHooks].join("\n\n"),
        ...withModelPromptBuildContext({
          promptBeforeHooks,
          transcriptPrompt: userText,
          prependContext,
        }),
      }),
    ).toEqual({
      prompt: userText,
      modelPrompt: [prependContext, userText].join("\n\n"),
      runtimeContext: [provenance, systemEvent].join("\n\n"),
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

  it("preserves repeated hook text when there is no hidden runtime context", () => {
    const modelPrompt = "Hello\n\nHook summary: Hello";
    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: "Hello",
        transcriptPrompt: "Hello",
        modelPrompt,
        ...withModelPromptBuildContext({
          promptBeforeHooks: "Hello",
          transcriptPrompt: "Hello",
          appendContext: "Hook summary: Hello",
        }),
      }),
    ).toEqual({
      prompt: "Hello",
      modelPrompt,
    });
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
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        "internal event",
        "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
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
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        "internal event",
        "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
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

    expect(
      buildCurrentInboundPrompt({
        context: { text: "   " },
        prompt: "visible ask",
      }),
    ).toBe("visible ask");
  });

  it("builds runtime context as prompt-local custom context before the current user prompt", () => {
    expect(buildRuntimeContextCustomMessage("secret runtime context")).toMatchObject({
      role: "custom",
      customType: "openclaw.runtime-context",
      content: [
        "OpenClaw runtime context for the immediately preceding user message.",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        "secret runtime context",
        "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      ].join("\n"),
      display: false,
      details: { source: "openclaw-runtime-context" },
    });
  });

  it("labels runtime-only events as system context", () => {
    const parts = resolveRuntimeContextPromptParts({
      effectivePrompt: "internal event",
      transcriptPrompt: "",
    });

    expect(parts.runtimeSystemContext).toContain("OpenClaw runtime event.");
    expect(parts.runtimeSystemContext).toContain("not user-authored");
    expect(parts.runtimeSystemContext).toContain("internal event");
  });
});
