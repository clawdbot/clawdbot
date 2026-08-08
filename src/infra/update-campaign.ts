// Coordinates the process-local idle/countdown window before an automatic update.
import { randomUUID } from "node:crypto";
import type { UpdateScheduleState } from "../../packages/gateway-protocol/src/index.js";
import {
  createGatewayActiveWorkSnapshot,
  type GatewayActiveWorkInspectors,
} from "./gateway-active-work.js";

const CAMPAIGN_FORCE_DELAY_MS = 15 * 60_000;
const CAMPAIGN_COUNTDOWN_MS = 60_000;
const CAMPAIGN_POLL_MS = 5_000;

type UpdateCampaignState = NonNullable<UpdateScheduleState["campaign"]>;
type UpdateCampaignTarget = NonNullable<UpdateScheduleState["target"]>;

type UpdateCampaignAnnouncement = {
  target: UpdateCampaignTarget;
  inspect?: Partial<GatewayActiveWorkInspectors>;
  apply: (context: { forced: boolean }) => Promise<void>;
  onChange: (campaign: UpdateCampaignState | undefined) => void;
};

type UpdateCampaignDependencies = {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  createId: () => string;
};

function sameTarget(a: UpdateCampaignTarget, b: UpdateCampaignTarget): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "package" && b.kind === "package") {
    return a.version === b.version;
  }
  return (
    a.kind === "git" &&
    b.kind === "git" &&
    a.upstreamRef === b.upstreamRef &&
    a.upstreamSha === b.upstreamSha &&
    a.commitsBehind === b.commitsBehind
  );
}

/** Owns the single in-memory automatic-update campaign for this process. */
export class UpdateCampaignController {
  private campaign: UpdateCampaignState | undefined;
  private target: UpdateCampaignTarget | undefined;
  private announcement: UpdateCampaignAnnouncement | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly dependencies: UpdateCampaignDependencies = {
      now: () => Date.now(),
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (timer) => clearTimeout(timer),
      createId: randomUUID,
    },
  ) {}

  getState(): UpdateCampaignState | undefined {
    return this.campaign;
  }

  announce(announcement: UpdateCampaignAnnouncement): void {
    if (this.target && this.campaign && sameTarget(this.target, announcement.target)) {
      this.announcement = announcement;
      this.reconcile();
      return;
    }

    this.cancelTimer();
    this.target = announcement.target;
    this.announcement = announcement;
    const now = this.dependencies.now();
    this.campaign = {
      id: this.dependencies.createId(),
      state: "waiting-for-idle",
      announcedAtMs: now,
      forceAtMs: now + CAMPAIGN_FORCE_DELAY_MS,
      updatedAtMs: now,
    };
    announcement.onChange(this.campaign);
    this.reconcile();
  }

  clear(): void {
    const onChange = this.announcement?.onChange;
    const hadCampaign = this.campaign !== undefined;
    this.reset();
    if (hadCampaign) {
      onChange?.(undefined);
    }
  }

  adopt(): boolean {
    if (!this.campaign || this.campaign.state === "applying") {
      return false;
    }
    this.beginApplying(false, false);
    return true;
  }

  resetForTest(): void {
    this.reset();
  }

  private reset(): void {
    this.cancelTimer();
    this.campaign = undefined;
    this.target = undefined;
    this.announcement = undefined;
  }

  private reconcile(): void {
    const campaign = this.campaign;
    const announcement = this.announcement;
    if (!campaign || !announcement || campaign.state === "applying") {
      return;
    }

    this.cancelTimer();
    const now = this.dependencies.now();
    if (now >= campaign.forceAtMs) {
      this.beginApplying(true, true);
      return;
    }

    let idle = false;
    try {
      idle = createGatewayActiveWorkSnapshot(announcement.inspect).idle;
    } catch {
      // Inspection failure must not erase the hard deadline or force an unsafe early apply.
    }
    if (!idle) {
      this.transition({
        id: campaign.id,
        state: "waiting-for-idle",
        announcedAtMs: campaign.announcedAtMs,
        forceAtMs: campaign.forceAtMs,
        updatedAtMs: now,
      });
      this.scheduleNext();
      return;
    }

    if (campaign.state === "waiting-for-idle") {
      this.transition({
        id: campaign.id,
        state: "countdown",
        announcedAtMs: campaign.announcedAtMs,
        applyAtMs: now + CAMPAIGN_COUNTDOWN_MS,
        forceAtMs: campaign.forceAtMs,
        updatedAtMs: now,
      });
      this.scheduleNext();
      return;
    }

    if (campaign.applyAtMs !== undefined && now >= campaign.applyAtMs) {
      this.beginApplying(false, true);
      return;
    }
    this.scheduleNext();
  }

  private transition(next: UpdateCampaignState): void {
    const current = this.campaign;
    const unchanged =
      current?.state === next.state &&
      current.applyAtMs === next.applyAtMs &&
      current.forceAtMs === next.forceAtMs;
    if (unchanged) {
      return;
    }
    this.campaign = next;
    this.announcement?.onChange(next);
  }

  private beginApplying(forced: boolean, runApply: boolean): void {
    const campaign = this.campaign;
    const announcement = this.announcement;
    if (!campaign || !announcement) {
      return;
    }
    this.cancelTimer();
    const now = this.dependencies.now();
    this.transition({
      id: campaign.id,
      state: "applying",
      announcedAtMs: campaign.announcedAtMs,
      forceAtMs: campaign.forceAtMs,
      updatedAtMs: now,
    });
    if (runApply) {
      void announcement.apply({ forced }).catch(() => undefined);
    }
  }

  private scheduleNext(): void {
    const campaign = this.campaign;
    if (!campaign || campaign.state === "applying") {
      return;
    }
    const now = this.dependencies.now();
    const nextBoundaryMs = Math.min(
      campaign.forceAtMs,
      campaign.applyAtMs ?? Number.POSITIVE_INFINITY,
    );
    const delayMs = Math.max(0, Math.min(CAMPAIGN_POLL_MS, nextBoundaryMs - now));
    this.timer = this.dependencies.setTimer(() => this.reconcile(), delayMs);
    this.timer.unref?.();
  }

  private cancelTimer(): void {
    if (this.timer === undefined) {
      return;
    }
    this.dependencies.clearTimer(this.timer);
    this.timer = undefined;
  }
}

export const gatewayUpdateCampaign = new UpdateCampaignController();
