import { beforeEach, describe, expect, it, vi } from "vitest";

const readActiveGatewayLockIdentity = vi.hoisted(() => vi.fn());
const sleep = vi.hoisted(() => vi.fn(async (_delayMs: number) => {}));

vi.mock("../../infra/gateway-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/gateway-lock.js")>();
  return {
    ...actual,
    readActiveGatewayLockIdentity: () => readActiveGatewayLockIdentity(),
  };
});

vi.mock("../../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils.js")>();
  return {
    ...actual,
    sleep: (delayMs: number) => sleep(delayMs),
  };
});

const previousLockIdentity = {
  pid: 4200,
  ownerId: "gateway-owner-old",
  createdAt: "2026-07-16T12:00:00.000Z",
  port: 18_789,
};

describe("waitForGatewayLockReplacement", () => {
  beforeEach(() => {
    readActiveGatewayLockIdentity.mockReset();
    sleep.mockClear();
  });

  it("checks for a replacement after the final bounded delay", async () => {
    const replacementLockIdentity = {
      ...previousLockIdentity,
      pid: 4300,
      ownerId: "gateway-owner-new",
      createdAt: "2026-07-16T12:00:01.000Z",
    };
    readActiveGatewayLockIdentity
      .mockResolvedValueOnce(previousLockIdentity)
      .mockResolvedValue(replacementLockIdentity);

    const { waitForGatewayLockReplacement } = await import("./restart-lock-replacement.js");
    await expect(
      waitForGatewayLockReplacement({
        previousLockIdentity,
        attempts: 1,
        delayMs: 500,
        waitIndefinitelyForPreviousOwner: false,
      }),
    ).resolves.toStrictEqual({
      status: "replacement",
      attemptsUsed: 1,
      lockIdentity: replacementLockIdentity,
    });
    expect(readActiveGatewayLockIdentity).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("bounds replacement startup after an indefinite previous-owner wait", async () => {
    readActiveGatewayLockIdentity
      .mockResolvedValueOnce(previousLockIdentity)
      .mockResolvedValue(undefined);

    const { waitForGatewayLockReplacement } = await import("./restart-lock-replacement.js");
    await expect(
      waitForGatewayLockReplacement({
        previousLockIdentity,
        attempts: 2,
        delayMs: 500,
        waitIndefinitelyForPreviousOwner: true,
      }),
    ).resolves.toStrictEqual({ status: "timeout" });
    expect(readActiveGatewayLockIdentity).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("does not treat a transient lock read failure as owner release", async () => {
    const replacementLockIdentity = {
      ...previousLockIdentity,
      pid: 4300,
      ownerId: "gateway-owner-new",
      createdAt: "2026-07-16T12:00:01.000Z",
    };
    readActiveGatewayLockIdentity
      .mockRejectedValueOnce(new Error("transient lock read failure"))
      .mockResolvedValueOnce(previousLockIdentity)
      .mockResolvedValue(replacementLockIdentity);

    const { waitForGatewayLockReplacement } = await import("./restart-lock-replacement.js");
    await expect(
      waitForGatewayLockReplacement({
        previousLockIdentity,
        attempts: 1,
        delayMs: 500,
        waitIndefinitelyForPreviousOwner: true,
      }),
    ).resolves.toStrictEqual({
      status: "replacement",
      attemptsUsed: 0,
      lockIdentity: replacementLockIdentity,
    });
    expect(readActiveGatewayLockIdentity).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
