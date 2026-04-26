const OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE = "openclaw.runtime-context";

type RuntimeContextSession = {
  sendCustomMessage: (
    message: {
      customType: string;
      content: string;
      display: boolean;
      details?: Record<string, unknown>;
    },
    options?: { deliverAs?: "nextTurn"; triggerTurn?: boolean },
  ) => Promise<void>;
};

type RuntimeContextPromptParts = {
  prompt: string;
  runtimeContext?: string;
  runtimeOnly?: boolean;
  runtimeSystemContext?: string;
};

function removeLastPromptOccurrence(text: string, prompt: string): string | null {
  const index = text.lastIndexOf(prompt);
  if (index === -1) {
    return null;
  }
  const before = text.slice(0, index).trimEnd();
  const after = text.slice(index + prompt.length).trimStart();
  return [before, after]
    .filter((part) => part.length > 0)
    .join("\n\n")
    .trim();
}

export function resolveRuntimeContextPromptParts(params: {
  effectivePrompt: string;
  transcriptPrompt?: string;
}): RuntimeContextPromptParts {
  const transcriptPrompt = params.transcriptPrompt;
  if (transcriptPrompt === undefined || transcriptPrompt === params.effectivePrompt) {
    return { prompt: params.effectivePrompt };
  }

  const prompt = transcriptPrompt.trim();
  const runtimeContext =
    removeLastPromptOccurrence(params.effectivePrompt, transcriptPrompt)?.trim() ||
    params.effectivePrompt.trim();
  if (!prompt) {
    return runtimeContext
      ? {
          prompt: "",
          runtimeContext,
          runtimeOnly: true,
          runtimeSystemContext: buildRuntimeEventSystemContext(runtimeContext),
        }
      : { prompt: "" };
  }

  return runtimeContext ? { prompt, runtimeContext } : { prompt };
}

function buildRuntimeContextMessageContent(params: {
  runtimeContext: string;
  kind: "next-turn" | "runtime-event";
}): string {
  return [
    params.kind === "runtime-event"
      ? "OpenClaw runtime event."
      : "OpenClaw runtime context for the immediately preceding user message.",
    "This context is runtime-generated, not user-authored. Keep internal details private.",
    "",
    params.runtimeContext,
  ].join("\n");
}

export function buildRuntimeEventSystemContext(runtimeContext: string): string {
  return buildRuntimeContextMessageContent({ runtimeContext, kind: "runtime-event" });
}

export async function queueRuntimeContextForNextTurn(params: {
  session: RuntimeContextSession;
  runtimeContext?: string;
}): Promise<void> {
  const runtimeContext = params.runtimeContext?.trim();
  if (!runtimeContext) {
    return;
  }
  await params.session.sendCustomMessage(
    {
      customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
      content: buildRuntimeContextMessageContent({ runtimeContext, kind: "next-turn" }),
      display: false,
      details: { source: "openclaw-runtime-context" },
    },
    { deliverAs: "nextTurn" },
  );
}
