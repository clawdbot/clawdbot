// Claim-owner liveness: PID/starttime identity and lease freshness.
import { describe, expect, it } from "vitest";
import {
  INGRESS_CLAIM_LEASE_MS,
  INGRESS_CLAIM_PROCESS_ID,
  isIngressClaimOwnedByOtherLiveProcess,
  isIngressCorruptClaimOwnedByOtherLiveProcess,
  processPidFromOwnerId,
} from "./ingress-claim-owner.js";

describe("ingress claim owner", () => {
  it("parses process pid from owner id", () => {
    expect(processPidFromOwnerId("4242:1000:dead-owner")).toBe(4242);
    expect(processPidFromOwnerId("not-a-pid:x:uuid")).toBe(-1);
    expect(processPidFromOwnerId("")).toBe(-1);
  });

  it("does not treat stale claims with reused pids as live-owned", () => {
    const now = Date.now();
    expect(
      isIngressClaimOwnedByOtherLiveProcess({
        claim: {
          processId: `${process.pid}:1:other-process`,
          processPid: process.pid,
          claimedAt: now - INGRESS_CLAIM_LEASE_MS - 1,
        },
      }),
    ).toBe(false);
  });

  it("does not treat fresh claims with the current pid and a different owner id as foreign", () => {
    const now = Date.now();
    expect(
      isIngressClaimOwnedByOtherLiveProcess({
        claim: {
          processId: `${process.pid}:1:other-process`,
          processPid: process.pid,
          claimedAt: now,
        },
      }),
    ).toBe(false);
  });

  it("does not treat a fresh foreign claim as live-owned when its pid is only a thread of this process", () => {
    const now = Date.now();
    // Incident shape: dead owner PID 9 is reused as a Linux TID of the new process.
    // process.kill(9, 0) succeeds, but starttime no longer matches the claim owner.
    expect(
      isIngressClaimOwnedByOtherLiveProcess(
        {
          claim: {
            processId: "9:1000:dead-owner",
            processPid: 9,
            claimedAt: now,
          },
        },
        {
          processExists: (pid) => pid === 9,
          readProcessStartTime: (pid) => (pid === 9 ? 2000 : null),
        },
      ),
    ).toBe(false);
  });

  it("does not treat a fresh foreign claim as live-owned when its pid was reused by an unrelated process", () => {
    const now = Date.now();
    expect(
      isIngressClaimOwnedByOtherLiveProcess(
        {
          claim: {
            processId: "4242:1000:dead-owner",
            processPid: 4242,
            claimedAt: now,
          },
        },
        {
          processExists: (pid) => pid === 4242,
          readProcessStartTime: (pid) => (pid === 4242 ? 9999 : null),
        },
      ),
    ).toBe(false);
  });

  it("treats fresh claims with other live process instances as live-owned", () => {
    const now = Date.now();
    const liveOwnerPid = process.ppid > 0 ? process.ppid : 1;
    expect(
      isIngressClaimOwnedByOtherLiveProcess(
        {
          claim: {
            processId: `${liveOwnerPid}:5555:other-process`,
            processPid: liveOwnerPid,
            claimedAt: now,
          },
        },
        {
          processExists: (pid) => pid === liveOwnerPid,
          readProcessStartTime: (pid) => (pid === liveOwnerPid ? 5555 : null),
        },
      ),
    ).toBe(true);
  });

  it("keeps existence-based lease protection for fresh legacy two-part owner ids", () => {
    const now = Date.now();
    const liveOwnerPid = process.ppid > 0 ? process.ppid : 1;
    // Rolling upgrade: a live pre-starttime worker still holds pid:uuid claims.
    // Stealing them while the owner process exists would double-dispatch.
    expect(
      isIngressClaimOwnedByOtherLiveProcess(
        {
          claim: {
            processId: `${liveOwnerPid}:legacy-owner`,
            processPid: liveOwnerPid,
            claimedAt: now,
          },
        },
        {
          processExists: () => true,
          readProcessStartTime: () => 1,
        },
      ),
    ).toBe(true);
  });

  it("accepts queue claim.ownerId shape", () => {
    const now = Date.now();
    expect(
      isIngressClaimOwnedByOtherLiveProcess(
        {
          claim: {
            token: "test-auth-token",
            ownerId: "99:5555:other",
            claimedAt: now,
          },
        },
        {
          processExists: (pid) => pid === 99,
          readProcessStartTime: (pid) => (pid === 99 ? 5555 : null),
        },
      ),
    ).toBe(true);
  });

  it("treats fresh corrupt claims owned by this process as still live", () => {
    const now = Date.now();
    expect(
      isIngressCorruptClaimOwnedByOtherLiveProcess({
        id: "e1",
        channelId: "test",
        accountId: "default",
        queueName: "q",
        reason: "corrupt_payload",
        claim: {
          token: "test-auth-token",
          ownerId: INGRESS_CLAIM_PROCESS_ID,
          claimedAt: now,
        },
      }),
    ).toBe(true);
  });
});
