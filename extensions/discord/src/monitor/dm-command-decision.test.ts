import { describe, expect, it, vi } from "vitest";
import type { DiscordDmCommandAccess } from "./dm-command-auth.js";
import { handleDiscordDmCommandDecision } from "./dm-command-decision.js";

function buildDmAccess(overrides: Partial<DiscordDmCommandAccess>): DiscordDmCommandAccess {
  return {
    decision: "allow",
    reason: "ok",
    commandAuthorized: true,
    allowMatch: { allowed: true, matchKey: "123", matchSource: "id" },
    ...overrides,
  };
}

const TEST_ACCOUNT_ID = "default";
const TEST_SENDER = { id: "123", tag: "alice#0001", name: "alice" };

function createDmDecisionHarness(params?: { pairingCreated?: boolean }) {
  const onPairingCreated = vi.fn(async () => {});
  const onUnauthorized = vi.fn(async () => {});
  const upsertPairingRequest = vi.fn(async () => ({
    code: "PAIR-1",
    created: params?.pairingCreated ?? true,
  }));
  return { onPairingCreated, onUnauthorized, upsertPairingRequest };
}

async function runPairingDecision(params?: { pairingCreated?: boolean }) {
  const harness = createDmDecisionHarness({ pairingCreated: params?.pairingCreated });
  const allowed = await handleDiscordDmCommandDecision({
    dmAccess: buildDmAccess({
      decision: "pairing",
      commandAuthorized: false,
      allowMatch: { allowed: false },
    }),
    accountId: TEST_ACCOUNT_ID,
    sender: TEST_SENDER,
    onPairingCreated: harness.onPairingCreated,
    onUnauthorized: harness.onUnauthorized,
    upsertPairingRequest: harness.upsertPairingRequest,
  });
  return { allowed, ...harness };
}

describe("handleDiscordDmCommandDecision", () => {
  it("returns true for allowed DM access", async () => {
    const { onPairingCreated, onUnauthorized, upsertPairingRequest } = createDmDecisionHarness();

    const allowed = await handleDiscordDmCommandDecision({
      dmAccess: buildDmAccess({ decision: "allow" }),
      accountId: TEST_ACCOUNT_ID,
      sender: TEST_SENDER,
      onPairingCreated,
      onUnauthorized,
      upsertPairingRequest,
    });

    expect(allowed).toBe(true);
    expect(upsertPairingRequest).not.toHaveBeenCalled();
    expect(onPairingCreated).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("creates pairing reply for new pairing requests", async () => {
    const { allowed, onPairingCreated, onUnauthorized, upsertPairingRequest } =
      await runPairingDecision();

    expect(allowed).toBe(false);
    expect(upsertPairingRequest).toHaveBeenCalledWith({
      channel: "discord",
      id: "123",
      accountId: TEST_ACCOUNT_ID,
      meta: {
        tag: TEST_SENDER.tag,
        name: TEST_SENDER.name,
      },
    });
    expect(onPairingCreated).toHaveBeenCalledWith("PAIR-1");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("skips pairing reply when pairing request already exists", async () => {
    const { allowed, onPairingCreated, onUnauthorized } = await runPairingDecision({
      pairingCreated: false,
    });

    expect(allowed).toBe(false);
    expect(onPairingCreated).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("runs unauthorized handler for blocked DM access", async () => {
    const { onPairingCreated, onUnauthorized, upsertPairingRequest } = createDmDecisionHarness();

    const allowed = await handleDiscordDmCommandDecision({
      dmAccess: buildDmAccess({
        decision: "block",
        commandAuthorized: false,
        allowMatch: { allowed: false },
      }),
      accountId: TEST_ACCOUNT_ID,
      sender: TEST_SENDER,
      onPairingCreated,
      onUnauthorized,
      upsertPairingRequest,
    });

    expect(allowed).toBe(false);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(upsertPairingRequest).not.toHaveBeenCalled();
    expect(onPairingCreated).not.toHaveBeenCalled();
  });
});
