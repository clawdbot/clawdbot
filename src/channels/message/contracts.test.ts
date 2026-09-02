// Message contract tests cover shared channel message shape and runtime invariants.
import { describe, expect, it, vi } from "vitest";
import {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveFinalizerProofs,
  verifyChannelMessageReceiveAckPolicyAdapterProofs,
  verifyDurableFinalCapabilityProofs,
} from "./contracts.js";
import { durableFinalDeliveryCapabilities } from "./types.js";

function verifiedEntries<T extends { status: string }>(results: readonly T[]): T[] {
  return results.filter((result) => result.status === "verified");
}

function expectOnlyVerifiedOrNotDeclared(results: readonly { status: string }[]): void {
  expect(
    results.every((result) => result.status === "verified" || result.status === "not_declared"),
  ).toBe(true);
}

describe("durable final capability contracts", () => {
  it("runs proofs for every declared durable-final capability", async () => {
    const text = vi.fn();
    const silent = vi.fn(async () => {});

    const results = await verifyDurableFinalCapabilityProofs({
      adapterName: "demo",
      capabilities: {
        text: true,
        silent: true,
      },
      proofs: {
        text,
        silent,
      },
    });
    expect(verifiedEntries(results)).toEqual([
      { capability: "text", status: "verified" },
      { capability: "silent", status: "verified" },
    ]);
    expect(results).toHaveLength(durableFinalDeliveryCapabilities.length);
    expectOnlyVerifiedOrNotDeclared(results);
    expect(text).toHaveBeenCalledTimes(1);
    expect(silent).toHaveBeenCalledTimes(1);
  });

  it("fails when a declared durable-final capability has no proof", async () => {
    await expect(
      verifyDurableFinalCapabilityProofs({
        adapterName: "demo",
        capabilities: {
          text: true,
          nativeQuote: true,
        },
        proofs: {
          text: () => {},
        },
      }),
    ).rejects.toThrow(
      'demo declares durable final capability "nativeQuote" without a contract proof',
    );
  });

  it("runs proofs from channel message adapter declarations", async () => {
    const text = vi.fn();
    const media = vi.fn();

    const results = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "demo",
      adapter: {
        durableFinal: {
          capabilities: {
            text: true,
            media: true,
          },
        },
      },
      proofs: {
        text,
        media,
      },
    });
    expect(verifiedEntries(results)).toEqual([
      { capability: "text", status: "verified" },
      { capability: "media", status: "verified" },
    ]);
    expect(results).toHaveLength(durableFinalDeliveryCapabilities.length);
    expectOnlyVerifiedOrNotDeclared(results);
    expect(text).toHaveBeenCalledTimes(1);
    expect(media).toHaveBeenCalledTimes(1);
  });

  it("runs live preview finalizer proofs from channel message adapter declarations", async () => {
    const finalEdit = vi.fn();
    const normalFallback = vi.fn();

    const results = await verifyChannelMessageLiveFinalizerProofs({
      adapterName: "demo",
      adapter: {
        live: {
          finalizer: {
            capabilities: {
              finalEdit: true,
              normalFallback: true,
            },
          },
        },
      },
      proofs: {
        finalEdit,
        normalFallback,
      },
    });
    expect(verifiedEntries(results)).toEqual([
      { capability: "finalEdit", status: "verified" },
      { capability: "normalFallback", status: "verified" },
    ]);
    expect(results).toHaveLength(5);
    expectOnlyVerifiedOrNotDeclared(results);
    expect(finalEdit).toHaveBeenCalledTimes(1);
    expect(normalFallback).toHaveBeenCalledTimes(1);
  });

  it("runs live capability proofs from channel message adapter declarations", async () => {
    const draftPreview = vi.fn();
    const previewFinalization = vi.fn();

    const results = await verifyChannelMessageLiveCapabilityAdapterProofs({
      adapterName: "demo",
      adapter: {
        live: {
          capabilities: {
            draftPreview: true,
            previewFinalization: true,
          },
        },
      },
      proofs: {
        draftPreview,
        previewFinalization,
      },
    });
    expect(verifiedEntries(results)).toEqual([
      { capability: "draftPreview", status: "verified" },
      { capability: "previewFinalization", status: "verified" },
    ]);
    expect(results).toHaveLength(5);
    expectOnlyVerifiedOrNotDeclared(results);
    expect(draftPreview).toHaveBeenCalledTimes(1);
    expect(previewFinalization).toHaveBeenCalledTimes(1);
  });

  it("runs receive ack policy proofs from channel message adapter declarations", async () => {
    const afterReceiveRecord = vi.fn();
    const afterAgentDispatch = vi.fn();

    const results = await verifyChannelMessageReceiveAckPolicyAdapterProofs({
      adapterName: "demo",
      adapter: {
        receive: {
          defaultAckPolicy: "after_agent_dispatch",
          supportedAckPolicies: ["after_receive_record", "after_agent_dispatch"],
        },
      },
      proofs: {
        after_receive_record: afterReceiveRecord,
        after_agent_dispatch: afterAgentDispatch,
      },
    });
    expect(verifiedEntries(results)).toEqual([
      { policy: "after_receive_record", status: "verified" },
      { policy: "after_agent_dispatch", status: "verified" },
    ]);
    expect(results).toHaveLength(4);
    expectOnlyVerifiedOrNotDeclared(results);
    expect(afterReceiveRecord).toHaveBeenCalledTimes(1);
    expect(afterAgentDispatch).toHaveBeenCalledTimes(1);
  });
});
