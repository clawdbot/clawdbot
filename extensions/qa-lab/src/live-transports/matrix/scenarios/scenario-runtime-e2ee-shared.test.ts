import { setTimeout as sleep } from "node:timers/promises";
import type { MatrixVerificationSummary } from "@openclaw/matrix/test-api.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatrixQaE2eeScenarioClient } from "../substrate/e2ee-client.js";
import { waitForMatrixQaVerificationSummary } from "./scenario-runtime-e2ee-shared.js";

vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function summary(overrides: Partial<MatrixVerificationSummary> = {}): MatrixVerificationSummary {
  return {
    id: "private-id",
    transactionId: "private-transaction",
    roomId: "private-room",
    otherUserId: "private-user",
    otherDeviceId: "private-device",
    isSelfVerification: true,
    initiatedByMe: false,
    phase: 1,
    phaseName: "requested",
    pending: true,
    methods: ["private-method"],
    canAccept: true,
    hasSas: true,
    sas: { decimal: [123, 456, 789], emoji: [["secret-emoji", "secret-label"]] },
    hasReciprocateQr: true,
    completed: false,
    error: "private-raw-error",
    createdAt: "private-created",
    updatedAt: "private-updated",
    ...overrides,
  };
}

describe("Matrix verification wait diagnostics", () => {
  it("reports only four latest phase/boolean states at the unchanged polling deadline", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(sleep).mockImplementation(async (ms) => {
      now += ms ?? 0;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const latest = Array.from({ length: 6 }, () => summary({ phaseName: "ready" }));
    const listVerifications = vi
      .fn<MatrixQaE2eeScenarioClient["listVerifications"]>()
      .mockResolvedValueOnce([summary()])
      .mockResolvedValue(latest);
    const client: Pick<MatrixQaE2eeScenarioClient, "listVerifications"> = { listVerifications };
    const predicate = vi.fn(() => false);
    const error = await waitForMatrixQaVerificationSummary({
      client: client as MatrixQaE2eeScenarioClient,
      label: "recipient ready",
      predicate,
      timeoutMs: 275,
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    const expected = Array.from({ length: 4 }, () => ({
      phase: "ready",
      pending: true,
      completed: false,
      initiatedByMe: false,
      hasReciprocateQr: true,
      hasSas: true,
      hasError: true,
    }));
    expect(message).toBe(
      `timed out waiting for Matrix verification summary: recipient ready; states=${JSON.stringify(expected)}`,
    );
    expect(stderr).toHaveBeenCalledExactlyOnceWith(`[matrix-verification-timeout] ${message}\n`);
    expect(listVerifications).toHaveBeenCalledTimes(2);
    expect(predicate).toHaveBeenCalledTimes(7);
    expect(vi.mocked(sleep).mock.calls.map(([ms]) => ms)).toEqual([250, 25]);
    expect(now).toBe(275);
  });

  it("returns the matching summary unchanged without timeout diagnostics", async () => {
    const expected = summary({ completed: true, phaseName: "done" });
    const listVerifications = vi
      .fn<MatrixQaE2eeScenarioClient["listVerifications"]>()
      .mockResolvedValue([summary(), expected]);
    const client: Pick<MatrixQaE2eeScenarioClient, "listVerifications"> = { listVerifications };
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(
      waitForMatrixQaVerificationSummary({
        client: client as MatrixQaE2eeScenarioClient,
        label: "complete",
        predicate: (entry) => entry.completed,
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(expected);
    expect(sleep).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});
