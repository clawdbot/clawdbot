import fs from "node:fs";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { vi } from "vitest";
import {
  base64url,
  composeOutbound,
  generateIdentity,
  MemoryAuditStore,
  type GuardAdapter,
  type SignedReceipt,
  type Verdict,
} from "../protocol/index.js";
import { ReefChannelConfigSchema } from "./config-schema.js";
import { sameReefPeerIdentity, type ReefPeerIdentity, type ReefPeerTrust } from "./friend-types.js";
import { ReefDeliveredStore, ReviewApprovalStore } from "./state.js";
import type { ReefTransportClient } from "./transport.js";
import type { ReefTrustStore } from "./trust-store.js";
import type { ReefKeys, ReefRejectionNoticeState } from "./types.js";

const model = "mock-2026-07-12";
const stateDirs: string[] = [];

export function resetFlowStoresForTests(): void {
  resetPluginStateStoreForTests();
  for (const stateDir of stateDirs.splice(0)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

export function flowStores() {
  const stateDir = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "reef-flow-"));
  stateDirs.push(stateDir);
  const runtime = createPluginRuntimeMock();
  runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
  return {
    reviews: new ReviewApprovalStore(runtime),
    delivered: new ReefDeliveredStore(runtime),
  };
}

export const allow: Verdict = {
  decision: "allow",
  category: "safe",
  reason: "Safe.",
  model,
  policyVersion: "v1",
};

export function guard(
  ...verdicts: Verdict[]
): GuardAdapter & { classify: ReturnType<typeof vi.fn> } {
  const classify = vi.fn(async () => verdicts[classify.mock.calls.length - 1] ?? verdicts.at(-1)!);
  return { providerId: "mock", pinnedModel: model, classify };
}

export function reefKeys(identity = generateIdentity()): ReefKeys {
  return {
    ...identity,
    auditKey: base64url(new Uint8Array(32).fill(1)),
    replayKey: base64url(new Uint8Array(32).fill(2)),
    keyEpoch: 1,
  };
}

export function config() {
  return ReefChannelConfigSchema.parse({
    handle: "bob",
    email: "bob@example.com",
    guard: {
      provider: "openai",
      pinnedModel: model,
      apiKeyEnv: "REEF_TEST_KEY",
      policyVersion: "v1",
      timeoutMs: 1_000,
    },
  });
}

export function peerTrust(
  identity: ReturnType<typeof generateIdentity>,
  overrides: Partial<ReefPeerTrust> = {},
): ReefPeerTrust {
  return {
    autonomy: "bounded",
    ed25519PublicKey: identity.signing.publicKey,
    x25519PublicKey: identity.encryption.publicKey,
    keyEpoch: 1,
    safetyNumberChanged: false,
    approvedAt: 1,
    ...overrides,
  };
}

export function trust(initial: Record<string, ReefPeerTrust>) {
  const values = new Map(Object.entries(initial));
  const deliveries = new Map<
    string,
    {
      bodyHash: string;
      textHash?: string;
      recipient: ReefPeerIdentity;
      resendDisabled?: true;
      rejection?: {
        category?: string;
        notice?: ReefRejectionNoticeState;
      };
    }
  >();
  const rejectionNotices = new Map<string, ReefRejectionNoticeState>();
  return {
    values,
    deliveries,
    rejectionNotices,
    store: {
      get: (peer: string) => values.get(peer),
      recordOutboundDelivery: (
        peer: string,
        id: string,
        binding: { bodyHash: string; textHash?: string; recipient: ReefPeerIdentity },
        options: { resendDisabled?: true } = {},
      ) => {
        const key = `${peer}:${id}`;
        if (deliveries.has(key)) {
          throw new Error(`duplicate delivery ${id}`);
        }
        deliveries.set(key, { ...binding, ...options });
      },
      outboundDelivery: (peer: string, id: string) => deliveries.get(`${peer}:${id}`),
      consumeOutboundDelivery: (
        peer: string,
        id: string,
        binding: { bodyHash: string; textHash?: string; recipient: ReefPeerIdentity },
      ) => {
        const key = `${peer}:${id}`;
        const current = deliveries.get(key);
        if (
          current?.bodyHash !== binding.bodyHash ||
          current.textHash !== binding.textHash ||
          !sameReefPeerIdentity(current.recipient, binding.recipient) ||
          current.rejection
        ) {
          return false;
        }
        return deliveries.delete(key);
      },
      discardOutboundDelivery: (
        peer: string,
        id: string,
        binding: { bodyHash: string; textHash?: string; recipient: ReefPeerIdentity },
      ) => {
        const key = `${peer}:${id}`;
        const current = deliveries.get(key);
        if (
          current?.bodyHash !== binding.bodyHash ||
          current.textHash !== binding.textHash ||
          !sameReefPeerIdentity(current.recipient, binding.recipient)
        ) {
          return false;
        }
        return deliveries.delete(key);
      },
      recordOutboundRejection: (
        peer: string,
        id: string,
        binding: { bodyHash: string; textHash?: string; recipient: ReefPeerIdentity },
        category?: string,
      ) => {
        const key = `${peer}:${id}`;
        const current = deliveries.get(key);
        if (
          current?.bodyHash !== binding.bodyHash ||
          current.textHash !== binding.textHash ||
          !sameReefPeerIdentity(current.recipient, binding.recipient)
        ) {
          return false;
        }
        if (current.rejection) {
          return true;
        }
        deliveries.set(key, {
          ...current,
          rejection: {
            ...(category ? { category } : {}),
            ...(current.resendDisabled ? { notice: { lastRejectionAt: Date.now() } } : {}),
          },
        });
        return true;
      },
      reserveOutboundRejectionNotice: (
        peer: string,
        id: string,
        recipient: ReefPeerIdentity,
        noticeState: ReefRejectionNoticeState,
      ) => {
        const key = `${peer}:${id}`;
        const current = deliveries.get(key);
        if (!current?.rejection || !sameReefPeerIdentity(current.recipient, recipient)) {
          throw new Error(`missing rejection ${id}`);
        }
        if (current.rejection.notice) {
          return { kind: "existing" as const, state: current.rejection.notice };
        }
        deliveries.set(key, {
          ...current,
          rejection: {
            ...current.rejection,
            notice: noticeState,
          },
        });
        return { kind: "reserved" as const };
      },
      completeOutboundRejection: (
        peer: string,
        id: string,
        noticeState: ReefRejectionNoticeState,
      ) => {
        const key = `${peer}:${id}`;
        const previous = rejectionNotices.get(peer);
        rejectionNotices.set(peer, {
          lastRejectionAt: Math.max(previous?.lastRejectionAt ?? 0, noticeState.lastRejectionAt),
          ...(previous?.lastResendAt !== undefined || noticeState.lastResendAt !== undefined
            ? {
                lastResendAt: Math.max(previous?.lastResendAt ?? 0, noticeState.lastResendAt ?? 0),
              }
            : {}),
        });
        const current = deliveries.get(key);
        if (!current) {
          return true;
        }
        if (!current?.rejection?.notice) {
          return false;
        }
        return deliveries.delete(key);
      },
      rejectionNoticeState: (peer: string) => rejectionNotices.get(peer),
    } as unknown as ReefTrustStore,
  };
}

export function transport() {
  return {
    acknowledge: vi.fn(async (_peer: string, _id: string, _receipt: SignedReceipt) => ({
      result: "deleted",
    })),
    sendEnvelope: vi.fn(
      async (_peer: string, value: Parameters<ReefTransportClient["sendEnvelope"]>[1]) => ({
        id: value.id,
        status: "queued",
      }),
    ),
  };
}

export async function envelope(
  sender: ReturnType<typeof generateIdentity>,
  recipient: ReefKeys,
  id: string,
  text: string,
) {
  return (
    await composeOutbound({
      id,
      from: "alice#1",
      to: "bob#1",
      body: { text },
      senderSigningSecretKey: sender.signing.secretKey,
      recipientEncryptionPublicKey: recipient.encryption.publicKey,
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(3)),
      policyVersion: "v1",
    })
  ).envelope;
}
