import type { GatewayEventFrame } from "../../api/gateway.ts";
import {
  reconcileCustodianEventNudge,
  shouldConsumeNudge,
  type CustodianEventNudge,
  type CustodianSendOutcome,
} from "./event-nudge.ts";
import type { CustodianSessionVariant } from "./session-lifecycle.ts";

interface CustodianNudgeOwner {
  eventNudge: CustodianEventNudge | null;
  eventNudgePending: CustodianEventNudge | null;
  eventNudgeClosed: boolean;
  channelOnboardingNudgeClosed: boolean;
  readonly sensitive: boolean;
  readonly activeVariant: CustodianSessionVariant;
  hasUnresolvedQuestion(): boolean;
  send(text: string): Promise<CustodianSendOutcome>;
  requestNudgeUpdate(): void;
}

export function receiveEventNudge(owner: CustodianNudgeOwner, event: GatewayEventFrame): void {
  if (owner.activeVariant !== "caretaker" || owner.eventNudgeClosed) {
    return;
  }
  [owner.eventNudge, owner.eventNudgePending] = reconcileCustodianEventNudge(
    owner.eventNudge,
    owner.eventNudgePending,
    event,
  );
  owner.requestNudgeUpdate();
}

export async function sendEventNudge(owner: CustodianNudgeOwner): Promise<void> {
  const nudge = owner.eventNudge;
  if (!nudge || owner.sensitive || owner.hasUnresolvedQuestion()) {
    return;
  }
  owner.eventNudgePending = nudge;
  owner.requestNudgeUpdate();
  const outcome = await owner.send(nudge.message);
  if (owner.eventNudgePending === nudge) {
    owner.eventNudgePending = null;
    const consumed = shouldConsumeNudge(owner.eventNudge, nudge, outcome);
    [owner.eventNudgeClosed, owner.eventNudge] = [consumed, consumed ? null : owner.eventNudge];
    owner.requestNudgeUpdate();
  }
}

export function dismissEventNudge(owner: CustodianNudgeOwner): void {
  [owner.eventNudge, owner.eventNudgeClosed] = [null, true];
  owner.requestNudgeUpdate();
}

export function dismissChannelOnboardingNudge(
  owner: CustodianNudgeOwner,
  replace: () => void,
): void {
  owner.channelOnboardingNudgeClosed = true;
  owner.requestNudgeUpdate();
  replace();
}

export function openChannelsFromOnboarding(
  owner: CustodianNudgeOwner,
  revokeNavigationAuthority: () => void,
  navigate: () => void,
): void {
  owner.channelOnboardingNudgeClosed = true;
  revokeNavigationAuthority();
  owner.requestNudgeUpdate();
  navigate();
}
