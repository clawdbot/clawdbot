import { describe, expect, it, vi } from "vitest";
import {
  PROGRESS_CARD_MAX_STEP_UTF8_BYTES,
  PROGRESS_CARD_MAX_STEPS,
  PROGRESS_CARD_MAX_UTF8_BYTES,
  type ProgressCard,
  type ProgressCardStep,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveCoreOperatorGatewayMethodScope } from "../methods/core-descriptors.js";
import type { ProgressCardStore } from "../progress-card-store.js";
import { createProgressCardHandlers } from "./progress-card.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

function createHarness() {
  const cards = new Map<string, ProgressCard>();
  const store: ProgressCardStore = {
    get: (sessionKey) => cards.get(sessionKey) ?? null,
    put: (sessionKey, input) => {
      const current = cards.get(sessionKey);
      if (!input.markdown && !input.steps?.length) {
        if (input.expectedRevision !== undefined && current?.revision !== input.expectedRevision) {
          return { card: current ?? null };
        }
        cards.delete(sessionKey);
        return { card: null };
      }
      const card = {
        sessionKey,
        revision: (cards.get(sessionKey)?.revision ?? 0) + 1,
        updatedAt: Date.now(),
        ...(input.markdown ? { markdown: input.markdown } : {}),
        ...(input.steps ? { steps: input.steps } : {}),
      };
      cards.set(sessionKey, card);
      return { card };
    },
  };
  const handlers = createProgressCardHandlers(store);
  const broadcast = vi.fn();
  const invoke = async (method: "progressCard.get" | "progressCard.put", params: unknown) => {
    const respond = vi.fn<RespondFn>();
    await handlers[method]!({
      params,
      respond,
      context: {
        broadcast,
        getRuntimeConfig: () => ({ agents: { list: [{ id: "main" }] } }),
      } as unknown as GatewayRequestContext,
    } as never);
    return respond;
  };
  return { broadcast, invoke };
}

describe("progress card gateway methods", () => {
  it("registers read and write scopes", () => {
    expect(resolveCoreOperatorGatewayMethodScope("progressCard.get")).toBe("operator.read");
    expect(resolveCoreOperatorGatewayMethodScope("progressCard.put")).toBe("operator.write");
  });

  it("roundtrips markdown and steps, strips invisible Unicode, and broadcasts the revision", async () => {
    const { broadcast, invoke } = createHarness();
    const plan = [
      { step: "Inspect\u200b", status: "completed" },
      { step: "Patch\u202e", status: "in_progress" },
    ];
    const expectedSteps: ProgressCardStep[] = [
      { step: "Inspect", status: "completed" },
      { step: "Patch", status: "in_progress" },
    ];
    const put = await invoke("progressCard.put", {
      sessionKey: "agent:main:main",
      markdown: "A\u200bB\u202eC",
      plan,
    });
    const get = await invoke("progressCard.get", { sessionKey: "agent:main:main" });

    expect(put).toHaveBeenCalledWith(
      true,
      { card: expect.objectContaining({ markdown: "ABC", steps: expectedSteps, revision: 1 }) },
      undefined,
    );
    expect(get).toHaveBeenCalledWith(
      true,
      { card: expect.objectContaining({ markdown: "ABC", steps: expectedSteps, revision: 1 }) },
      undefined,
    );
    expect(broadcast).toHaveBeenCalledWith("progressCard.changed", {
      sessionKey: "agent:main:main",
      revision: 1,
    });
  });

  it.each([
    {
      name: "oversized markdown",
      payload: { markdown: "é".repeat(PROGRESS_CARD_MAX_UTF8_BYTES / 2 + 1) },
      message: `${PROGRESS_CARD_MAX_UTF8_BYTES} UTF-8 bytes`,
    },
    {
      name: "too many steps",
      payload: {
        plan: Array.from({ length: PROGRESS_CARD_MAX_STEPS + 1 }, (_, index) => ({
          step: `Step ${index}`,
          status: "pending",
        })),
      },
      message: `more than ${PROGRESS_CARD_MAX_STEPS} items`,
    },
    {
      name: "oversized step",
      payload: {
        plan: [
          {
            step: "é".repeat(PROGRESS_CARD_MAX_STEP_UTF8_BYTES / 2 + 1),
            status: "pending",
          },
        ],
      },
      message: `${PROGRESS_CARD_MAX_STEP_UTF8_BYTES} UTF-8 bytes`,
    },
    {
      name: "multiple active steps",
      payload: {
        plan: [
          { step: "One", status: "in_progress" },
          { step: "Two", status: "in_progress" },
        ],
      },
      message: "at most one in_progress",
    },
  ])("rejects $name without broadcasting", async ({ payload, message }) => {
    const { broadcast, invoke } = createHarness();
    const respond = await invoke("progressCard.put", {
      sessionKey: "agent:main:main",
      ...payload,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining(message) }),
    );
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("clears the card and broadcasts a null revision", async () => {
    const { broadcast, invoke } = createHarness();
    await invoke("progressCard.put", {
      sessionKey: "agent:main:main",
      markdown: "Working",
    });
    broadcast.mockClear();
    const clear = await invoke("progressCard.put", { sessionKey: "agent:main:main" });

    expect(clear).toHaveBeenCalledWith(true, { card: null }, undefined);
    expect(broadcast).toHaveBeenCalledWith("progressCard.changed", {
      sessionKey: "agent:main:main",
      revision: null,
    });
  });

  it("dismisses only the matching completed revision", async () => {
    const { broadcast, invoke } = createHarness();
    await invoke("progressCard.put", {
      sessionKey: "agent:main:main",
      plan: [{ step: "Done", status: "completed" }],
    });
    broadcast.mockClear();

    const stale = await invoke("progressCard.put", {
      sessionKey: "agent:main:main",
      expectedRevision: 2,
    });
    const dismissed = await invoke("progressCard.put", {
      sessionKey: "agent:main:main",
      expectedRevision: 1,
    });

    expect(stale).toHaveBeenCalledWith(
      true,
      { card: expect.objectContaining({ revision: 1 }) },
      undefined,
    );
    expect(dismissed).toHaveBeenCalledWith(true, { card: null }, undefined);
    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith("progressCard.changed", {
      sessionKey: "agent:main:main",
      revision: null,
    });
  });
});
