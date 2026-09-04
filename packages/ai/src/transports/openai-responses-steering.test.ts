import type { ResponseInput } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { StreamOptions, UserMessage } from "../types.js";
import {
  createResponsesSteering,
  omitAcceptedSteering,
  projectResponsesSteeringInput,
} from "./openai-responses-steering.js";

const messages: UserMessage[] = [{ role: "user", content: "change direction", timestamp: 1 }];
const input: ResponseInput = [{ role: "user", content: "change direction" }];
const created = { type: "response.created", response: { id: "resp_1" } };
const acknowledgement = (type: string, id = "steer_1", responseId = "resp_1") => ({
  type: `response.steer.${type}`,
  steer: { id, previous_response_id: responseId },
});

function setup(options: Partial<Parameters<typeof createResponsesSteering>[0]> = {}) {
  let control!: Parameters<NonNullable<StreamOptions["onActiveResponse"]>>[0];
  const cleanup = vi.fn();
  const send = vi.fn();
  const assertActive = vi.fn();
  const steering = createResponsesSteering({
    onActiveResponse: (next) => {
      control = next;
      return cleanup;
    },
    toInput: () => input,
    send,
    assertActive,
    ...options,
  });
  return {
    steering,
    get control() {
      return control;
    },
    cleanup,
    send,
    assertActive,
  };
}

describe("Responses steering admission", () => {
  it("projects JSON-serializable payload hooks using their wire representation", async () => {
    const metadata = { probe: { toJSON: () => "wire-value" } };
    const request = { input: [...input], metadata };
    const appended: ResponseInput = [{ role: "user", content: "later update" }];
    await expect(
      projectResponsesSteeringInput(request, async () => ({
        ...request,
        input: [...request.input, ...appended],
      })),
    ).resolves.toEqual(appended);
    expect(request.input).toEqual(input);
    expect(request.metadata).toBe(metadata);
  });
  it("binds queued input to the created response and retains accepted input for continuation", async () => {
    const harness = setup();
    expect(harness.steering.responseId).toBeUndefined();
    expect(harness.steering.handle(created)).toBe(false);
    expect(harness.steering.responseId).toBe("resp_1");
    const accepted = harness.control.steer(messages);
    expect(harness.send).toHaveBeenCalledWith({
      type: "response.steer",
      previous_response_id: "resp_1",
      input,
    });
    expect(harness.steering.pending).toBe(true);
    expect(harness.steering.acceptedInput).toEqual([]);
    expect(harness.steering.handle(acknowledgement("accepted"))).toBe(true);
    expect(await accepted).toBe(true);
    expect(harness.steering.pending).toBe(false);
    expect(harness.steering.acceptedInput).toEqual(input);
    expect(
      harness.steering.handle({
        ...acknowledgement("pending"),
        reason: "waiting_for_required_input",
        required_input: [{ type: "function_call_output", call_id: "call_1", name: "lookup" }],
      }),
    ).toBe(true);
    harness.steering.seal();
    expect(await harness.control.steer(messages)).toBe(false);
    expect(harness.cleanup).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenCalledOnce();
  });

  it.each(["steer_1", undefined])(
    "distinguishes rejection with ID %s before acceptance from failure after acceptance",
    async (id) => {
      const harness = setup();
      harness.steering.handle(created);
      const rejected = harness.control.steer(messages);
      harness.steering.handle({
        ...acknowledgement("failed"),
        steer: {
          previous_response_id: "resp_1",
          ...(id === undefined ? {} : { id }),
          input,
        },
        error: { code: "steering_not_supported" },
      });
      expect(await rejected).toBe(false);
      expect(harness.steering.acceptedInput).toEqual([]);
      const accepted = harness.control.steer(messages);
      harness.steering.handle(acknowledgement("accepted", "steer_2"));
      expect(await accepted).toBe(true);
      expect(() => harness.steering.handle(acknowledgement("failed", "steer_2"))).toThrow(
        "could not apply accepted steering",
      );
      expect(harness.steering.acceptedInput).toEqual(input);
      harness.steering.seal();
    },
  );

  it("matches rejection before ID allocation to the returned pending input", async () => {
    const later: UserMessage[] = [{ role: "user", content: "later update", timestamp: 2 }];
    const laterInput: ResponseInput = [{ role: "user", content: "later update" }];
    const harness = setup({
      toInput: vi
        .fn<(messages: readonly UserMessage[]) => ResponseInput>()
        .mockReturnValueOnce(input)
        .mockReturnValueOnce(laterInput),
    });
    harness.steering.handle(created);
    const first = harness.control.steer(messages);
    const second = harness.control.steer(later);
    const failure = {
      type: "response.steer.failed",
      steer: { previous_response_id: "resp_1", input: laterInput },
      error: { code: "response_already_completed" },
    };
    expect(harness.steering.handle(failure)).toBe(true);
    expect(await second).toBe(false);
    expect(harness.steering.pending).toBe(true);
    expect(harness.steering.acceptedInput).toEqual([]);
    expect(() => harness.steering.handle(failure)).toThrow("no pending submission");
    harness.steering.handle(acknowledgement("accepted"));
    expect(await first).toBe(true);
    expect(harness.steering.pending).toBe(false);
    expect(harness.steering.acceptedInput).toEqual(input);
    harness.steering.seal();
  });

  it.each([
    acknowledgement("accepted", "steer_1", "resp_other"),
    acknowledgement("accepted", ""),
    { type: "response.steer.accepted", steer: { previous_response_id: "resp_1" } },
    { type: "response.steer.pending", steer: { previous_response_id: "resp_1" } },
    { type: "response.steer.failed", steer: { previous_response_id: "resp_other", input } },
    acknowledgement("pending", "steer_unknown"),
  ])("rejects unowned acknowledgements without consuming pending input: $type", async (event) => {
    const harness = setup();
    harness.steering.handle(created);
    const pending = harness.control.steer(messages);
    expect(() => harness.steering.handle(event)).toThrow(/identity|no accepted submission/);
    expect(harness.steering.pending).toBe(true);
    const rejection = expect(pending).rejects.toThrow("connection closed");
    harness.steering.close(new Error("connection closed"));
    await rejection;
  });

  it.each(["accepted", "failed"])(
    "does not apply a duplicate %s acknowledgement to a later submission",
    async (type) => {
      const harness = setup();
      harness.steering.handle(created);
      const first = harness.control.steer(messages);
      harness.steering.handle(acknowledgement(type));
      await first;
      const second = harness.control.steer(messages);
      expect(() => harness.steering.handle(acknowledgement(type))).toThrow("already applied");
      expect(harness.steering.pending).toBe(true);
      const rejection = expect(second).rejects.toThrow("connection closed");
      harness.steering.close(new Error("connection closed"));
      await rejection;
      expect(harness.steering.acceptedInput).toEqual(type === "accepted" ? input : []);
    },
  );

  it("rejects unresolved admission on closure and fences the retained controller", async () => {
    const harness = setup();
    harness.steering.handle(created);
    const pending = harness.control.steer(messages);
    const rejection = expect(pending).rejects.toThrow("connection lost");
    harness.steering.close(new Error("connection lost"));
    await rejection;
    harness.steering.close(new Error("already closed"));
    expect(await harness.control.steer(messages)).toBe(false);
    expect(harness.steering.handle({ type: "response.created", response: { id: "resp_2" } })).toBe(
      false,
    );
    expect(harness.steering.responseId).toBe("resp_1");
    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.cleanup).toHaveBeenCalledOnce();
  });

  it("does not dispatch when conversion closes the response owner", async () => {
    const harness = setup({
      toInput: () => {
        harness.steering.seal();
        return input;
      },
    });
    harness.steering.handle(created);
    expect(await harness.control.steer(messages)).toBe(false);
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.steering.pending).toBe(false);
  });

  it("revalidates authority after conversion before dispatch", () => {
    let active = true;
    const harness = setup({
      assertActive: () => {
        if (!active) {
          throw new Error("stale response");
        }
      },
      toInput: () => {
        active = false;
        return input;
      },
    });
    harness.steering.handle(created);
    expect(() => harness.control.steer(messages)).toThrow("stale response");
    expect(harness.send).not.toHaveBeenCalled();
    harness.steering.seal();
  });

  it.each(["closed", "replaced"])(
    "fences %s ownership during awaited payload projection",
    async (reason) => {
      const projection = createDeferred<ResponseInput>();
      let active = true;
      const harness = setup({
        toInput: () => projection.promise,
        assertActive: () => {
          if (!active) {
            throw new Error("stale response");
          }
        },
      });
      harness.steering.handle(created);
      const admission = harness.control.steer(messages);
      if (reason === "closed") {
        harness.steering.seal();
      } else {
        active = false;
      }
      const outcome =
        reason === "closed"
          ? expect(admission).resolves.toBe(false)
          : expect(admission).rejects.toThrow("stale response");
      projection.resolve(input);
      await outcome;
      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.steering.pending).toBe(false);
      harness.steering.seal();
    },
  );

  it("cleans up registration even when its callback closes the owner synchronously", () => {
    const cleanup = vi.fn();
    const harness = setup({
      onActiveResponse: () => {
        harness.steering.seal();
        return cleanup;
      },
    });
    harness.steering.handle(created);
    harness.steering.seal();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("retires its cleanup before invoking a reentrant close", () => {
    const cleanup = vi.fn(() => harness.steering.seal());
    const harness = setup({ onActiveResponse: () => cleanup });
    harness.steering.handle(created);
    harness.steering.seal();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe("accepted steering continuation input", () => {
  it("omits exactly the accepted copies and preserves every other input in order", () => {
    const toolResult = {
      type: "function_call_output" as const,
      call_id: "call_1",
      output: "result",
    };
    const update = { type: "configuration_update" as const, reasoning: { effort: "high" } };
    const next = [...input, toolResult, ...input, update];
    expect(omitAcceptedSteering(next, input)).toEqual([toolResult, ...input, update]);
    expect(next).toEqual([...input, toolResult, ...input, update]);
    expect(() => omitAcceptedSteering([toolResult], input)).toThrow("accepted user input");
  });
});
