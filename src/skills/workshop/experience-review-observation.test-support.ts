import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import * as responsesEgress from "../../../packages/ai/src/transports/openai-responses-prompt-observer-internal.js";
import { SessionManager } from "../../agents/sessions/index.js";
import { readExperienceReviewMessageText } from "./experience-review-message-text.test-support.js";

export async function observeExperienceReview(run: () => Promise<void>) {
  let session: SessionManager | undefined;
  const requests: Array<{ toolNames: string[]; outputs: unknown[] }> = [];
  const openModelContext = SessionManager.openModelContext.bind(SessionManager);
  const createEgressObserver = responsesEgress.createResponsesPromptEgressObserver;
  // Keep the actual runner and transport. Silent reviews suppress public assistant events;
  // the detached transcript and final provider request own the facts this smoke needs.
  const sessionSpy = vi.spyOn(SessionManager, "openModelContext").mockImplementation((...args) => {
    session = openModelContext(...args);
    return session;
  });
  const providerSpy = vi
    .spyOn(responsesEgress, "createResponsesPromptEgressObserver")
    .mockImplementation((...args) => {
      const originalObserver = createEgressObserver(...args);
      return (request, metadata) => {
        const payload: unknown = request;
        const tools = isRecord(payload) && Array.isArray(payload.tools) ? payload.tools : [];
        const input = Array.isArray(request.input) ? request.input : [];
        if (requests.length === 0) {
          requests.push({
            toolNames: tools.flatMap((tool) =>
              isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
            ),
            outputs: input.flatMap((item) =>
              isRecord(item) && item.type === "function_call_output" ? [item.output] : [],
            ),
          });
        }
        originalObserver?.(request, metadata);
      };
    });
  try {
    await run();
    if (!session) {
      throw new Error("Workshop review did not create a detached transcript");
    }
    const messages = session.buildSessionContext().messages;
    const review = messages.slice(messages.findLastIndex((message) => message.role === "user") + 1);
    const final = review.findLast((message) => message.role === "assistant");
    return {
      requests,
      finalText: final ? readExperienceReviewMessageText(final.content).trim() : "",
      toolCalls: review.flatMap((message) =>
        message.role === "assistant"
          ? message.content.filter((part) => part.type === "toolCall")
          : [],
      ),
      toolResults: review.filter((message) => message.role === "toolResult"),
    };
  } finally {
    providerSpy.mockRestore();
    sessionSpy.mockRestore();
  }
}
