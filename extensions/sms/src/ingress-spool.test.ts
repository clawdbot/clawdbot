// Sms tests cover durable Twilio webhook admission and replay.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SmsChannelRuntime } from "./inbound.js";
import { createSmsIngressSpool } from "./ingress-spool.js";
import type { ResolvedSmsAccount } from "./types.js";

type SmsIngressPayload = {
  version: 1;
  form: Record<string, string>;
};

const account: ResolvedSmsAccount = {
  accountId: "default",
  enabled: true,
  accountSid: "AC123",
  authToken: "secret",
  fromNumber: "+15557654321",
  messagingServiceSid: "",
  defaultTo: "",
  webhookPath: "/webhooks/sms",
  publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
  dangerouslyDisableSignatureValidation: false,
  dmPolicy: "pairing",
  allowFrom: [],
  textChunkLimit: 1500,
};

const stateDirs: string[] = [];
const disposers: Array<() => void> = [];
type SmsIngressDeliver = NonNullable<Parameters<typeof createSmsIngressSpool>[0]["deliver"]>;
type SmsIngressSpool = ReturnType<typeof createSmsIngressSpool>;

async function createStateDir(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), "openclaw-sms-ingress-"));
  const resolved = await realpath(created);
  stateDirs.push(resolved);
  return resolved;
}

function createQueue(stateDir: string) {
  return createChannelIngressQueueForTests<SmsIngressPayload>({
    channelId: "sms",
    accountId: account.accountId,
    stateDir,
  });
}

function form(messageSid: string): Record<string, string> {
  return {
    AccountSid: account.accountSid,
    From: "+15551234567",
    To: "+15557654321",
    Body: "hello",
    MessageSid: messageSid,
  };
}

async function drainSpool(spool: SmsIngressSpool): Promise<void> {
  await spool.drainOnce();
  await spool.waitForIdle();
}

afterEach(async () => {
  for (const dispose of disposers.splice(0).toReversed()) {
    dispose();
  }
  for (const stateDir of stateDirs.splice(0).toReversed()) {
    await rm(stateDir, { recursive: true, force: true });
  }
});

describe("createSmsIngressSpool", () => {
  it("recovers an uncompleted message with a fresh drain instance", async () => {
    const stateDir = await createStateDir();
    const first = createSmsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as SmsChannelRuntime,
      queue: createQueue(stateDir),
      deliver: vi.fn<SmsIngressDeliver>(async () => undefined),
    });
    disposers.push(first.dispose);
    await first.enqueue(form("SM-restart"));
    first.dispose();

    const deliver = vi.fn<SmsIngressDeliver>(async (_message, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const recovered = createSmsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as SmsChannelRuntime,
      queue: createQueue(stateDir),
      deliver,
    });
    disposers.push(recovered.dispose);
    await drainSpool(recovered);

    expect(deliver).toHaveBeenCalledOnce();
  });

  it("keeps a completed MessageSid tombstone from dispatching twice", async () => {
    const stateDir = await createStateDir();
    const deliver = vi.fn<SmsIngressDeliver>(async (_message, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const spool = createSmsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as SmsChannelRuntime,
      queue: createQueue(stateDir),
      deliver,
    });
    disposers.push(spool.dispose);

    expect(await spool.enqueue(form("SM-completed"))).toMatchObject({
      kind: "accepted",
      duplicate: false,
    });
    await drainSpool(spool);
    expect(await spool.enqueue(form("SM-completed"))).toMatchObject({
      kind: "completed",
      duplicate: true,
    });
    await drainSpool(spool);

    expect(deliver).toHaveBeenCalledOnce();
  });

  it.each(["SmsSid", "SmsMessageSid"])("accepts the legacy %s event id alias", async (key) => {
    const stateDir = await createStateDir();
    const deliver = vi.fn<SmsIngressDeliver>(async (_message, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const spool = createSmsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as SmsChannelRuntime,
      queue: createQueue(stateDir),
      deliver,
    });
    disposers.push(spool.dispose);
    const rawForm = form("SM-alias");
    delete rawForm.MessageSid;
    rawForm[key] = "SM-alias";

    expect(await spool.enqueue(rawForm)).toMatchObject({ kind: "accepted", duplicate: false });
    await drainSpool(spool);

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ messageSid: "SM-alias" }),
      expect.any(Object),
      expect.any(Number),
    );
  });

  it("uses the canonical sender as the durable lane", async () => {
    const stateDir = await createStateDir();
    const queue = createQueue(stateDir);
    const spool = createSmsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as SmsChannelRuntime,
      queue,
      deliver: vi.fn<SmsIngressDeliver>(async () => undefined),
    });
    disposers.push(spool.dispose);

    await spool.enqueue({ ...form("SM-canonical-lane"), From: "RcS:+1 (555) 123-4567" });

    expect(await queue.listPending()).toEqual([
      expect.objectContaining({ laneKey: "sender:+15551234567" }),
    ]);
  });

  it("replays with the original webhook receipt timestamp", async () => {
    const stateDir = await createStateDir();
    const receivedAt = 1_700_000_000_456;
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(receivedAt)
      .mockReturnValue(receivedAt + 60_000);
    const first = createSmsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as SmsChannelRuntime,
      queue: createQueue(stateDir),
      deliver: vi.fn<SmsIngressDeliver>(async () => undefined),
    });
    disposers.push(first.dispose);
    await first.enqueue(form("SM-received-at"));
    first.dispose();
    now.mockRestore();

    const deliver = vi.fn<SmsIngressDeliver>(async (_message, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const recovered = createSmsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as SmsChannelRuntime,
      queue: createQueue(stateDir),
      deliver,
    });
    disposers.push(recovered.dispose);
    await drainSpool(recovered);

    expect(deliver).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), receivedAt);
  });

  it("preserves the old handler-reload replay guard scenario with a tombstone", async () => {
    const stateDir = await createStateDir();
    const firstDeliver = vi.fn<SmsIngressDeliver>(async (_message, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const first = createSmsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as SmsChannelRuntime,
      queue: createQueue(stateDir),
      deliver: firstDeliver,
    });
    disposers.push(first.dispose);
    await first.enqueue(form("SM-handler-reload"));
    await drainSpool(first);
    first.dispose();

    const reloadedDeliver = vi.fn<SmsIngressDeliver>(async () => undefined);
    const reloaded = createSmsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as SmsChannelRuntime,
      queue: createQueue(stateDir),
      deliver: reloadedDeliver,
    });
    disposers.push(reloaded.dispose);
    expect(await reloaded.enqueue(form("SM-handler-reload"))).toMatchObject({
      kind: "completed",
      duplicate: true,
    });
    await drainSpool(reloaded);

    expect(firstDeliver).toHaveBeenCalledOnce();
    expect(reloadedDeliver).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid payload", { MessageSid: "SM-invalid", From: "+15551234567" }],
    ["account mismatch", { ...form("SM-account"), AccountSid: "AC-other" }],
  ])("dead-letters a permanent %s failure", async (_label, rawForm) => {
    const stateDir = await createStateDir();
    const deliver = vi.fn<SmsIngressDeliver>(async () => undefined);
    const spool = createSmsIngressSpool({
      cfg: {},
      account,
      channelRuntime: {} as SmsChannelRuntime,
      queue: createQueue(stateDir),
      deliver,
    });
    disposers.push(spool.dispose);

    await spool.enqueue(rawForm);
    await drainSpool(spool);

    expect(await spool.enqueue(rawForm)).toMatchObject({ kind: "failed", duplicate: true });
    expect(deliver).not.toHaveBeenCalled();
  });
});
