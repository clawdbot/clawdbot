import { describe, expect, it, vi } from "vitest";
import {
  listDeclaredChannelMessageLiveCapabilities,
  listDeclaredDurableFinalCapabilities,
  listDeclaredLivePreviewFinalizerCapabilities,
  listDeclaredReceiveAckPolicies,
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveFinalizerProofs,
  verifyChannelMessageLiveCapabilityProofs,
  verifyChannelMessageReceiveAckPolicyAdapterProofs,
  verifyChannelMessageReceiveAckPolicyProofs,
  verifyDurableFinalCapabilityProofs,
  verifyLivePreviewFinalizerCapabilityProofs,
} from "./contracts.js";

describe("durable final capability contracts", () => {
  it("lists declared durable-final capabilities in stable order", () => {
    expect(
      listDeclaredDurableFinalCapabilities({
        batch: true,
        afterCommit: true,
        reconcileUnknownSend: true,
        text: true,
        silent: false,
        thread: true,
      }),
    ).toEqual(["text", "thread", "batch", "reconcileUnknownSend", "afterCommit"]);
  });

  it("runs proofs for every declared durable-final capability", async () => {
    const text = vi.fn();
    const silent = vi.fn(async () => {});

    await expect(
      verifyDurableFinalCapabilityProofs({
        adapterName: "demo",
        capabilities: {
          text: true,
          silent: true,
        },
        proofs: {
          text,
          silent,
        },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { capability: "text", status: "verified" },
        { capability: "silent", status: "verified" },
      ]),
    );
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

    await expect(
      verifyChannelMessageAdapterCapabilityProofs({
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
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { capability: "text", status: "verified" },
        { capability: "media", status: "verified" },
      ]),
    );
    expect(text).toHaveBeenCalledTimes(1);
    expect(media).toHaveBeenCalledTimes(1);
  });

  it("runs live preview finalizer proofs from channel message adapter declarations", async () => {
    const finalEdit = vi.fn();
    const normalFallback = vi.fn();

    expect(
      listDeclaredLivePreviewFinalizerCapabilities({
        previewReceipt: false,
        normalFallback: true,
        finalEdit: true,
      }),
    ).toEqual(["finalEdit", "normalFallback"]);

    await expect(
      verifyChannelMessageLiveFinalizerProofs({
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
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { capability: "finalEdit", status: "verified" },
        { capability: "normalFallback", status: "verified" },
      ]),
    );
    expect(finalEdit).toHaveBeenCalledTimes(1);
    expect(normalFallback).toHaveBeenCalledTimes(1);
  });

  it("runs live capability proofs from channel message adapter declarations", async () => {
    const draftPreview = vi.fn();
    const previewFinalization = vi.fn();

    expect(
      listDeclaredChannelMessageLiveCapabilities({
        nativeStreaming: false,
        previewFinalization: true,
        draftPreview: true,
      }),
    ).toEqual(["draftPreview", "previewFinalization"]);

    await expect(
      verifyChannelMessageLiveCapabilityAdapterProofs({
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
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { capability: "draftPreview", status: "verified" },
        { capability: "previewFinalization", status: "verified" },
      ]),
    );
    expect(draftPreview).toHaveBeenCalledTimes(1);
    expect(previewFinalization).toHaveBeenCalledTimes(1);
  });

  it("fails when a declared live preview finalizer capability has no proof", async () => {
    await expect(
      verifyLivePreviewFinalizerCapabilityProofs({
        adapterName: "demo",
        capabilities: {
          finalEdit: true,
          previewReceipt: true,
        },
        proofs: {
          finalEdit: () => {},
        },
      }),
    ).rejects.toThrow(
      'demo declares live preview finalizer capability "previewReceipt" without a contract proof',
    );
  });

  it("fails when a declared live capability has no proof", async () => {
    await expect(
      verifyChannelMessageLiveCapabilityProofs({
        adapterName: "demo",
        capabilities: {
          draftPreview: true,
          progressUpdates: true,
        },
        proofs: {
          draftPreview: () => {},
        },
      }),
    ).rejects.toThrow('demo declares live capability "progressUpdates" without a contract proof');
  });

  it("runs receive ack policy proofs from channel message adapter declarations", async () => {
    const afterReceiveRecord = vi.fn();
    const afterAgentDispatch = vi.fn();

    expect(
      listDeclaredReceiveAckPolicies({
        defaultAckPolicy: "after_agent_dispatch",
        supportedAckPolicies: ["after_agent_dispatch", "after_receive_record"],
      }),
    ).toEqual(["after_receive_record", "after_agent_dispatch"]);

    await expect(
      verifyChannelMessageReceiveAckPolicyAdapterProofs({
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
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { policy: "after_receive_record", status: "verified" },
        { policy: "after_agent_dispatch", status: "verified" },
      ]),
    );
    expect(afterReceiveRecord).toHaveBeenCalledTimes(1);
    expect(afterAgentDispatch).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default receive ack policy when supported policies are omitted", () => {
    expect(
      listDeclaredReceiveAckPolicies({
        defaultAckPolicy: "after_durable_send",
      }),
    ).toEqual(["after_durable_send"]);
  });

  it("treats manual receive acknowledgement as an explicit plugin-owned policy", async () => {
    const manual = vi.fn();

    expect(
      listDeclaredReceiveAckPolicies({
        defaultAckPolicy: "manual",
        supportedAckPolicies: ["manual"],
      }),
    ).toEqual(["manual"]);

    await expect(
      verifyChannelMessageReceiveAckPolicyProofs({
        adapterName: "demo",
        receive: {
          defaultAckPolicy: "manual",
          supportedAckPolicies: ["manual"],
        },
        proofs: { manual },
      }),
    ).resolves.toEqual(expect.arrayContaining([{ policy: "manual", status: "verified" }]));
    expect(manual).toHaveBeenCalledTimes(1);
  });

  it("fails when a declared receive ack policy has no proof", async () => {
    await expect(
      verifyChannelMessageReceiveAckPolicyProofs({
        adapterName: "demo",
        receive: {
          supportedAckPolicies: ["after_receive_record", "manual"],
        },
        proofs: {
          after_receive_record: () => {},
        },
      }),
    ).rejects.toThrow('demo declares receive ack policy "manual" without a contract proof');
  });
});
