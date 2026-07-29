// Covers question message finalization lifecycle and delivery races.
import { describe, expect, it, vi } from "vitest";
import type { QuestionRecord } from "../../packages/gateway-protocol/src/schema/questions.js";
import { createQuestionChannelRuntime } from "./question-channel-runtime-internal.js";

const record: QuestionRecord = {
  id: "ask_0123456789abcdef0123456789abcdef",
  status: "pending",
  questions: [
    {
      questionId: "target",
      header: "Target",
      question: "Deploy where?",
      options: [{ label: "Staging" }, { label: "Production" }],
    },
  ],
  createdAtMs: 1,
  expiresAtMs: 2,
};

describe("question channel runtime", () => {
  it("finalizes delivered messages once with canonical answer labels", async () => {
    const finalize = vi.fn();
    const runtime = createQuestionChannelRuntime();
    runtime.handleRequested(record);
    runtime.registerDelivery({ questionId: record.id, deliveryId: "telegram:1", finalize });

    const event = {
      id: record.id,
      status: "answered" as const,
      answers: { answers: { target: ["Production"] } },
    };
    runtime.handleResolved(event);
    runtime.handleResolved(event);
    await vi.waitFor(() => expect(finalize).toHaveBeenCalledOnce());
    expect(finalize).toHaveBeenCalledWith("Answered: Production");
    runtime.clear();
  });

  it("finalizes expiry delivered after the terminal event", async () => {
    const finalize = vi.fn();
    const runtime = createQuestionChannelRuntime();
    runtime.handleRequested(record);
    runtime.handleResolved({ id: record.id, status: "expired" });
    runtime.registerDelivery({ questionId: record.id, deliveryId: "slack:1", finalize });

    await vi.waitFor(() => expect(finalize).toHaveBeenCalledOnce());
    expect(finalize).toHaveBeenCalledWith("Expired");
    runtime.clear();
  });

  it("does not echo free-text answers", async () => {
    const finalize = vi.fn();
    const runtime = createQuestionChannelRuntime();
    runtime.handleRequested({
      ...record,
      questions: [{ ...record.questions[0]!, options: [], isOther: true }],
    });
    runtime.registerDelivery({ questionId: record.id, deliveryId: "telegram:text", finalize });
    runtime.handleResolved({
      id: record.id,
      status: "answered",
      answers: { answers: { target: ["@everyone secret-ish text"] } },
    });

    await vi.waitFor(() => expect(finalize).toHaveBeenCalledWith("Answered"));
    runtime.clear();
  });

  it("retains terminal state beyond the gateway grace for late delivery capture", async () => {
    vi.useFakeTimers();
    try {
      const finalize = vi.fn();
      const runtime = createQuestionChannelRuntime();
      runtime.handleRequested(record);
      runtime.handleResolved({ id: record.id, status: "expired" });
      await vi.advanceTimersByTimeAsync(15_001);
      runtime.registerDelivery({ questionId: record.id, deliveryId: "slack:late", finalize });

      expect(finalize).toHaveBeenCalledWith("Expired");
      runtime.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports finalizer failures without retrying a double resolve", async () => {
    const error = new Error("edit failed");
    const onFinalizeError = vi.fn();
    const runtime = createQuestionChannelRuntime({ onFinalizeError });
    runtime.handleRequested(record);
    runtime.registerDelivery({
      questionId: record.id,
      deliveryId: "discord:1",
      finalize: () => {
        throw error;
      },
    });
    runtime.handleResolved({ id: record.id, status: "cancelled" });
    runtime.handleResolved({ id: record.id, status: "cancelled" });

    await vi.waitFor(() => expect(onFinalizeError).toHaveBeenCalledOnce());
    expect(onFinalizeError).toHaveBeenCalledWith(error, record.id, "discord:1");
    runtime.clear();
  });
});

describe("terminal status labels", () => {
  it("echoes declared option answers even when free-text input was allowed", async () => {
    const recordWithOther: QuestionRecord = {
      id: "ask_q",
      questions: [
        {
          questionId: "deploy",
          header: "Deploy",
          question: "Where?",
          options: [{ label: "Staging" }, { label: "Production" }],
          isOther: true,
        },
      ],
      createdAtMs: 1,
      expiresAtMs: 2,
      status: "answered",
      answers: { answers: { deploy: ["Staging"] } },
    };
    const finalize = vi.fn();
    const runtime = createQuestionChannelRuntime();
    runtime.handleRequested(recordWithOther);
    runtime.registerDelivery({ questionId: recordWithOther.id, deliveryId: "test:1", finalize });
    runtime.handleResolved({
      id: "ask_q",
      status: "answered",
      answers: { answers: { deploy: ["Staging"] } },
    });

    await vi.waitFor(() => expect(finalize).toHaveBeenCalledWith("Answered: Staging"));
    runtime.clear();
  });
});
