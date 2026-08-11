// Coordinates the process-local idle/countdown window before an automatic update.
import { randomUUID } from "node:crypto";
import type { UpdateScheduleState } from "../../packages/gateway-protocol/src/index.js";
import {
  createGatewayActiveWorkSnapshot,
  type GatewayActiveWorkInspectors,
} from "./gateway-active-work.js";

const CAMPAIGN_FORCE_DELAY_MS = 15 * 60_000;
const CAMPAIGN_COUNTDOWN_MS = 60_000;
const CAMPAIGN_HOLD_MS = 60 * 60_000;
const CAMPAIGN_POLL_MS = 5_000;

type UpdateCampaignState = NonNullable<UpdateScheduleState["campaign"]>;
type UpdateCampaignTarget = NonNullable<UpdateScheduleState["target"]>;

type UpdateCampaignAdoption = {
  campaignId: string;
  target: UpdateCampaignTarget;
};

type UpdateCampaignAnnouncement = {
  target: UpdateCampaignTarget;
  inspect?: Partial<GatewayActiveWorkInspectors>;
  apply: (context: { forced: boolean }) => Promise<"handoff" | "applied" | "failed">;
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
  private held = false;

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
    this.held = false;
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

  adopt(): UpdateCampaignAdoption | undefined {
    const campaign = this.campaign;
    const target = this.target;
    if (!campaign || !target || campaign.state === "applying") {
      return undefined;
    }
    this.beginApplying(false, false);
    return { campaignId: campaign.id, target: { ...target } };
  }

  hold(durationMs = CAMPAIGN_HOLD_MS): boolean {
    const campaign = this.campaign;
    if (!campaign || campaign.state === "applying" || this.held) {
      return false;
    }
    this.cancelTimer();
    this.held = true;
    const now = this.dependencies.now();
    const holdUntilMs = now + durationMs;
    this.transition({
      id: campaign.id,
      state: "waiting-for-idle",
      announcedAtMs: campaign.announcedAtMs,
      holdUntilMs,
      forceAtMs: holdUntilMs + CAMPAIGN_FORCE_DELAY_MS,
      updatedAtMs: now,
    });
    this.scheduleNext();
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
    this.held = false;
  }

  private reconcile(): void {
    const campaign = this.campaign;
    const announcement = this.announcement;
    if (!campaign || !announcement || campaign.state === "applying") {
      return;
    }

    this.cancelTimer();
    const now = this.dependencies.now();
    if (campaign.holdUntilMs !== undefined && now < campaign.holdUntilMs) {
      this.scheduleNext();
      return;
    }
    if (now >= campaign.forceAtMs) {
      this.beginApplying(true, true);
      return;
    }

    if (campaign.state === "waiting-for-idle") {
      let idle = false;
      try {
        idle = createGatewayActiveWorkSnapshot(announcement.inspect).idle;
      } catch {
        // Inspection failure must not erase the hard deadline or force an unsafe early apply.
      }
      if (!idle) {
        this.scheduleNext();
        return;
      }
      this.transition({
        id: campaign.id,
        state: "countdown",
        announcedAtMs: campaign.announcedAtMs,
        applyAtMs: now + CAMPAIGN_COUNTDOWN_MS,
        ...(campaign.holdUntilMs === undefined ? {} : { holdUntilMs: campaign.holdUntilMs }),
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
      current.holdUntilMs === next.holdUntilMs &&
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
      ...(campaign.holdUntilMs === undefined ? {} : { holdUntilMs: campaign.holdUntilMs }),
      forceAtMs: campaign.forceAtMs,
      updatedAtMs: now,
    });
    if (runApply) {
      // An apply can settle after clear/new announce; only its originating campaign may be cleared.
      void announcement.apply({ forced }).then(
        (outcome) => {
          if (outcome === "failed" && this.campaign?.id === campaign.id) {
            this.clear();
          }
        },
        () => {
          if (this.campaign?.id === campaign.id) {
            this.clear();
          }
        },
      );
    }
  }

  private scheduleNext(): void {
    const campaign = this.campaign;
    if (!campaign || campaign.state === "applying") {
      return;
    }
    const now = this.dependencies.now();
    const holdBoundaryMs =
      campaign.holdUntilMs !== undefined && campaign.holdUntilMs > now
        ? campaign.holdUntilMs
        : Number.POSITIVE_INFINITY;
    const nextBoundaryMs = Math.min(
      campaign.forceAtMs,
      campaign.applyAtMs ?? Number.POSITIVE_INFINITY,
      holdBoundaryMs,
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
