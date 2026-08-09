import {
  type GatewayLockIdentity,
  isSameGatewayLockIdentity,
  readActiveGatewayLockIdentity,
} from "../../infra/gateway-lock.js";
import { sleep } from "../../utils.js";

type GatewayLockReplacementWaitResult =
  | {
      status: "replacement";
      attemptsUsed: number;
      lockIdentity: GatewayLockIdentity;
    }
  | { status: "timeout" };

export async function waitForGatewayLockReplacement(params: {
  previousLockIdentity: GatewayLockIdentity;
  attempts: number;
  delayMs: number;
  waitIndefinitelyForPreviousOwner: boolean;
}): Promise<GatewayLockReplacementWaitResult> {
  let attemptsUsed = 0;
  let previousOwnerReleased = false;

  for (;;) {
    let currentLockIdentity: GatewayLockIdentity | undefined;
    try {
      currentLockIdentity = await readActiveGatewayLockIdentity();
    } catch {
      if (params.waitIndefinitelyForPreviousOwner && !previousOwnerReleased) {
        await sleep(params.delayMs);
        continue;
      }
      if (attemptsUsed >= params.attempts) {
        return { status: "timeout" };
      }
      attemptsUsed += 1;
      await sleep(params.delayMs);
      continue;
    }

    if (!previousOwnerReleased) {
      if (
        currentLockIdentity &&
        isSameGatewayLockIdentity(params.previousLockIdentity, currentLockIdentity)
      ) {
        if (params.waitIndefinitelyForPreviousOwner) {
          await sleep(params.delayMs);
          continue;
        }
      } else {
        previousOwnerReleased = true;
        if (params.waitIndefinitelyForPreviousOwner) {
          attemptsUsed = 0;
        }
      }
    }

    if (
      previousOwnerReleased &&
      currentLockIdentity &&
      !isSameGatewayLockIdentity(params.previousLockIdentity, currentLockIdentity)
    ) {
      return { status: "replacement", attemptsUsed, lockIdentity: currentLockIdentity };
    }

    if (attemptsUsed >= params.attempts) {
      return { status: "timeout" };
    }
    attemptsUsed += 1;
    await sleep(params.delayMs);
  }
}
