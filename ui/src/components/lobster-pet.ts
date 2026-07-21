// Decorative lobster pet that perches on the sidebar footer and mirrors
// gateway status: it idles (naps, waves, wanders) when nothing is running,
// scurries while runs are active, and paces worriedly while disconnected.
// Drawn in the smooth OpenClaw lobster style (see the dreams scene and
// icons.lobster). Look and personality are seeded per session + page load so
// every new session hatches a slightly different lobster.
import "../styles/lobster-pet.css";
import { expectDefined } from "@openclaw/normalization-core";
import { LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { isLobsterDay } from "../../../src/shared/lobster-day.js";
import * as dex from "./lobster-dex.ts";
import { playLobsterPetChirp, type LobsterPetChirpKind } from "./lobster-pet-audio.ts";
import * as contract from "./lobster-pet-contract.ts";
import * as lobsterLook from "./lobster-pet-look.ts";
import "./lobster-pet-standin.ts";
import * as plans from "./lobster-pet-plans.ts";
import { LobsterLedgeTraffic } from "./lobster-pet-traffic.ts";

export {
  LOBSTER_LOGO_VISIT_EVENT,
  lobsterPetSeed,
  resolveLobsterPetMode,
  resolveLobsterRunOutcome,
  type LobsterLogoVisitDetail,
  type LobsterLogoVisitPhase,
  type LobsterPetLook,
  type LobsterPetMode,
  type LobsterRunOutcome,
} from "./lobster-pet-contract.ts";
export {
  LOBSTER_PET_PALETTES,
  canonicalLobsterLook,
  createLobsterPetLook,
  renderLobsterSvg,
} from "./lobster-pet-look.ts";

class LobsterPet extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) seed = 0;
  @property({ attribute: false }) mode: contract.LobsterPetMode = "idle";

  @property({ attribute: false }) visitsEnabled = true;
  @property({ attribute: false }) runOutcome: contract.LobsterRunOutcome = "ok";
  @property({ attribute: false }) soundsEnabled = false;
  @property({ attribute: false }) gatewayVersion: string | null = null;

  @state() private act: plans.LobsterPetAct | null = null;
  @state() private spotPct = 80;
  @state() private facing: 1 | -1 = 1;
  @state() private entering = false;
  @state() private entrance: contract.LobsterPetEntrance = "walk";
  @state() private presence: "out" | "in" | "leaving" = "out";
  @state() private anchor: plans.LobsterPetAnchor = "ledge";
  @state() private scheduledVisiting = false;
  @state() private logoPerched = false;
  @state() private logoScared = false;
  private logoScarePending = false;
  private logoScareTimer: number | null = null;
  private scareRng: () => number = lobsterLook.mulberry32(0);
  private logoPlanned = false;
  private logoDone = false;
  private lastLogoPhase: contract.LobsterLogoVisitPhase = "out";
  @state() private dismissed = false;
  @state() private grumpy = false;
  @state() private vigil = false;
  @state() private outcomePresenceOwner: "vigil" | null = null;
  @state() private movingDay = false;
  private movingDayChecked = false;
  @state() private anniversary = false;
  private sailorDay = false;
  // Rare-load identity resolved once per seed (Elder, old-friend returns,
  // Lobsterdex completion) - a load-start snapshot, like familiarity.
  private identity: plans.LobsterLoadIdentity | null = null;
  private entranceRng: () => number = lobsterLook.mulberry32(0);
  // Passers and the bottle run on their own clocks beside the resident.
  private readonly traffic = new LobsterLedgeTraffic(this, {
    visitsEnabled: () => this.visitsEnabled,
    onPasserFacing: (facing) => this.watchTraffic(facing),
    onPasserMidCross: () => this.reactToPasser(),
    onPasserDone: () => this.scheduleNextAct(),
  });
  @state() private shellVisible = false;
  private shellSpotPct = 50;
  private shellScale = 2;
  private molted = false;
  private moltPlanned = false;
  private twinPlanned = false;
  private shellTimer: number | null = null;
  private familiarity: dex.LobsterFamiliarity = {
    tier: "regular",
    wary: false,
    visits: 0,
    shoos: 0,
  };
  private greetedThisLoad = false;

  private look: contract.LobsterPetLook | null = null;
  private rng: () => number = lobsterLook.mulberry32(0);
  private visitRng: () => number = lobsterLook.mulberry32(0);
  private idleTimer: number | null = null;
  private actEndTimer: number | null = null;
  private enterTimer: number | null = null;
  private visitTimer: number | null = null;
  private leaveTimer: number | null = null;
  private grumpyTimer: number | null = null;
  private vigilTimer: number | null = null;
  private holdTimer: number | null = null;
  private holdPetted = false;
  private audioCtx: AudioContext | null = null;
  private pokeTimes: number[] = [];
  private lastGazeAt = 0;
  private restartPending = false;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    document.addEventListener("pointermove", this.handleGaze, { passive: true });
  }

  override disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.clearActTimers();
    this.clearVisitTimers();
    if (this.grumpyTimer !== null) {
      window.clearTimeout(this.grumpyTimer);
      this.grumpyTimer = null;
    }
    if (this.shellTimer !== null) {
      window.clearTimeout(this.shellTimer);
      this.shellTimer = null;
    }
    for (const timer of [this.vigilTimer, this.holdTimer, this.logoScareTimer]) {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    }
    this.vigilTimer = null;
    this.holdTimer = null;
    this.logoScareTimer = null;
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    document.removeEventListener("pointermove", this.handleGaze);
    super.disconnectedCallback();
  }

  private wantsVisible(): boolean {
    return (
      this.visitsEnabled &&
      !this.dismissed &&
      (this.mode === "offline" ||
        this.vigil ||
        this.outcomePresenceOwner !== null ||
        this.scheduledVisiting)
    );
  }

  override willUpdate(changed: Map<PropertyKey, unknown>) {
    const seedChanged = this.look === null || changed.has("seed");
    if (seedChanged) {
      this.look = lobsterLook.createLobsterPetLook(this.seed);
      this.rng = lobsterLook.mulberry32(this.seed ^ 0x9e3779b9);
      this.visitRng = lobsterLook.mulberry32(this.seed ^ 0x5eaf00d);
      this.scareRng = lobsterLook.mulberry32((this.seed ^ 0x5ca2e) >>> 0);
      this.entranceRng = lobsterLook.mulberry32((this.seed ^ 0xe27a) >>> 0);
      this.identity = plans.resolveLobsterLoadIdentity(this.seed, this.look);
      this.look = this.identity.look;
      this.spotPct = this.look.spotPct;
      this.facing = this.look.facing;
      // Reset the act loop inside the update pass; deferring state flips to
      // updated() would chain a second update and trip lit's change-in-update
      // warning.
      this.clearActTimers();
      this.act = null;
      this.dismissed = false;
      this.presence = "out";
      this.molted = false;
      this.shellVisible = false;
      if (this.shellTimer !== null) {
        window.clearTimeout(this.shellTimer);
        this.shellTimer = null;
      }
      // The Elder never molts: it is already every size it will ever need.
      this.moltPlanned = plans.isLobsterMoltLoad(this.seed) && !this.identity.elder;
      this.twinPlanned = plans.isLobsterTwinLoad(this.seed);
      this.logoPlanned = plans.isLobsterLogoLoad(this.seed);
      this.logoDone = false;
      this.logoPerched = false;
      this.logoScared = false;
      this.logoScarePending = false;
      if (this.logoScareTimer !== null) {
        window.clearTimeout(this.logoScareTimer);
        this.logoScareTimer = null;
      }
      this.familiarity = dex.getLobsterFamiliarity();
      this.sailorDay = isLobsterDay(new Date());
      this.greetedThisLoad = false;
      this.scheduleVisits();
      this.traffic.reset(this.seed);
      // The first update takes this branch, so the mode-change branch below
      // never sees the initial mode: arm the vigil tracker here as well.
      this.vigil = false;
      this.outcomePresenceOwner = null;
      this.trackVigil();
    } else if (changed.has("mode")) {
      // Status duty outranks the impersonation: any non-idle mode sends the
      // logo stand-in scurrying back to the ledge, where the status acts
      // below play out as usual.
      if (this.logoPerched && this.mode !== "idle") {
        this.logoPerched = false;
      }
      const previousMode = changed.get("mode") as contract.LobsterPetMode | undefined;
      const finished = previousMode === "busy" && this.mode === "idle";
      const presenceOwner = finished && this.vigil ? "vigil" : null;
      this.trackVigil();
      if (this.presence === "in" && !plans.prefersReducedMotion()) {
        // Status flips get an immediate reaction. A finished run (busy ->
        // idle) earns a cheer when it succeeded and a sympathetic droop when
        // it failed; everything else startles. The act-end timer then
        // reschedules from the new mode's pool.
        // Success cheers, failure droops, a user abort is nothing to
        // celebrate or mourn - just acknowledge the change.
        const finishAct = plans.resolveLobsterFinishAct(this.runOutcome);
        this.performAct(finished ? finishAct : "startle", presenceOwner);
      }
    }
    // Moving day latches once per load, as soon as the gateway version is
    // known (the hello can land after the first render).
    if (!this.movingDayChecked && this.gatewayVersion) {
      this.movingDayChecked = true;
      this.movingDay = plans.detectLobsterMovingDay(this.gatewayVersion);
    }
    // The completed-Lobsterdex trim lives on the host so it survives the pet
    // being out; the visits setting and dismissals silence it too.
    this.toggleAttribute(
      "data-dex-complete",
      (this.identity?.dexComplete ?? false) && this.visitsEnabled && !this.dismissed,
    );
    this.reconcilePresence();
  }

  // Presence follows the visit schedule, offline summons, the setting, and
  // dismissals. Runs inside the update pass so arrivals/departures never
  // chain a post-update state change.
  private reconcilePresence() {
    const visible = this.wantsVisible();
    if (visible && this.presence !== "in") {
      if (this.leaveTimer !== null) {
        window.clearTimeout(this.leaveTimer);
        this.leaveTimer = null;
      }
      if (this.presence === "out") {
        this.rollPerch();
        // A planned logo load spends its first scheduled visit up top as the
        // brand mark (once per load); offline summons always take the ledge.
        this.logoPerched =
          this.logoPlanned && !this.logoDone && this.scheduledVisiting && this.mode === "idle";
        if (this.logoPerched) {
          this.logoDone = true;
        }
        // One scare roll per arrival keeps the stream aligned across visit
        // kinds; only an idle ledge visit may spook the logo (a perch owns
        // the slot outright, offline summons are on status duty).
        const scareRolled = this.scareRng() < plans.LOGO_SCARE_CHANCE;
        this.logoScarePending =
          scareRolled &&
          !this.logoPerched &&
          this.scheduledVisiting &&
          this.mode === "idle" &&
          !plans.prefersReducedMotion();
        // Entrance rolls burn once per arrival on their own stream, aligned
        // across visit kinds like the scare roll above.
        this.entrance = plans.pickLobsterEntrance(this.entranceRng());
        if (this.look) {
          // Anniversary check reads the dex before this arrival records into
          // it: a first-ever visit today must not celebrate itself.
          this.anniversary = dex.isLobsterFirstVisitAnniversary(
            dex.getLobsterdexEntries().get(this.look.palette.id)?.firstSeenAt ?? null,
            new Date(),
          );
          // Every genuine arrival (visit or offline summon) logs the palette
          // with the first visitor's name (the Elder signs as itself) and
          // any shiny sighting, and bumps the familiarity count.
          dex.recordLobsterVisit(this.look.palette.id, {
            name: this.identity
              ? plans.lobsterLoadDisplayName(this.identity, this.seed)
              : lobsterLook.lobsterPetName(this.look, this.seed),
            shiny: this.look.shiny,
          });
          dex.recordLobsterArrivalStats();
        }
      }
      this.presence = "in";
      this.entering = !plans.prefersReducedMotion();
      this.restartPending = true;
      return;
    }
    if (!visible && this.presence === "in") {
      this.outcomePresenceOwner = null;
      this.clearActTimers();
      this.act = null;
      this.entering = false;
      this.logoScarePending = false;
      if (this.logoScareTimer !== null) {
        window.clearTimeout(this.logoScareTimer);
        this.logoScareTimer = null;
      }
      this.presence = "leaving";
      this.leaveTimer = window.setTimeout(() => {
        this.leaveTimer = null;
        this.presence = "out";
        this.logoPerched = false;
        // The "out" edge is the single restore point: the logo fades back
        // in the same update that ends the visit, scare or perch alike.
        this.logoScared = false;
      }, plans.LEAVE_MS);
    }
  }

  override updated() {
    this.dispatchLogoPhase();
    if (!this.restartPending) {
      return;
    }
    this.restartPending = false;
    this.enterTimer = window.setTimeout(() => {
      this.enterTimer = null;
      this.entering = false;
      // Familiar humans and returning old friends get a hello: the first
      // arrival of the load waves at you. A logo stand-in skips the greeting
      // (and keeps it for a ledge visit).
      if (
        !this.greetedThisLoad &&
        (this.familiarity.tier === "friend" || this.identity?.oldFriend === true) &&
        this.presence === "in" &&
        !this.logoPerched &&
        !plans.prefersReducedMotion()
      ) {
        this.greetedThisLoad = true;
        this.performAct("wave");
      }
    }, plans.LOBSTER_PET_ENTRANCE_MS[this.entrance]);
    if (this.logoScarePending) {
      this.logoScarePending = false;
      // The beat between arrival and the duck is what sells "the crab scared
      // the logo" instead of reading as a render glitch.
      this.logoScareTimer = window.setTimeout(() => {
        this.logoScareTimer = null;
        if (this.presence === "in" && !this.logoPerched) {
          this.logoScared = true;
        }
      }, plans.LOGO_SCARE_DELAY_MS);
    }
    this.scheduleNextAct();
  }

  private logoVisitPhase(): contract.LobsterLogoVisitPhase {
    const occupied = this.logoPerched || this.logoScared;
    if (!occupied || !this.visitsEnabled || this.dismissed) {
      return "out";
    }
    return this.presence === "in" ? "in" : this.presence === "leaving" ? "leaving" : "out";
  }

  // The brand slot lives in the sidebar's DOM; phase edges cross over as
  // events so exactly one home renders the crab at any moment.
  private dispatchLogoPhase() {
    const phase = this.logoVisitPhase();
    if (phase === this.lastLogoPhase) {
      return;
    }
    this.lastLogoPhase = phase;
    // Scare phases send no look: the logo just hides, nobody fills in.
    const look = phase === "out" || !this.logoPerched || !this.look ? null : this.look;
    // The ledge sprite dresses up for palette anniversaries; the stand-in
    // celebrates the same way.
    const dressed =
      look && this.anniversary && look.accessory !== "party"
        ? { ...look, accessory: "party" as const }
        : look;
    const name =
      dressed && this.identity ? plans.lobsterLoadDisplayName(this.identity, this.seed) : null;
    this.dispatchEvent(
      new CustomEvent<contract.LobsterLogoVisitDetail>(contract.LOBSTER_LOGO_VISIT_EVENT, {
        detail: { phase, look: dressed, name },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private readonly handleVisibilityChange = () => {
    if (document.hidden) {
      this.outcomePresenceOwner = null;
      this.clearActTimers();
      this.act = null;
    } else {
      this.scheduleNextAct();
    }
  };

  // Press-and-hold pets the lobster (content eyes, a floating heart); a
  // quick tap is a poke. Pokes are fun until they are not: 3 fast pokes turn
  // it grumpy for a minute, 10 send it off in a huff until a later visit.
  // Offline pets are on duty and never huff.
  private readonly handleHoldStart = () => {
    if (plans.prefersReducedMotion()) {
      return;
    }
    this.holdPetted = false;
    if (this.holdTimer !== null) {
      window.clearTimeout(this.holdTimer);
    }
    this.holdTimer = window.setTimeout(() => {
      this.holdTimer = null;
      this.holdPetted = true;
      this.grumpy = false;
      this.playChirp("pet");
      this.performAct("pet");
    }, 600);
  };

  private readonly handleHoldEnd = () => {
    if (this.holdTimer !== null) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = null;
      if (!this.holdPetted) {
        this.pokeNow();
      }
    }
    this.holdPetted = false;
  };

  private readonly handleHoldCancel = () => {
    if (this.holdTimer !== null) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.holdPetted = false;
  };

  private playChirp(kind: LobsterPetChirpKind) {
    this.audioCtx = playLobsterPetChirp(this.audioCtx, this.soundsEnabled, kind);
  }

  private pokeNow() {
    this.playChirp("poke");
    const now = Date.now();
    this.pokeTimes = [...this.pokeTimes.filter((at) => now - at < 6000), now];
    if (this.pokeTimes.length >= 10 && this.mode !== "offline") {
      this.huffOff();
      return;
    }
    if (this.pokeTimes.length >= 3) {
      this.enterGrumpy();
    }
    this.performAct("startle");
  }

  private enterGrumpy() {
    this.grumpy = true;
    if (this.grumpyTimer !== null) {
      window.clearTimeout(this.grumpyTimer);
    }
    this.grumpyTimer = window.setTimeout(() => {
      this.grumpyTimer = null;
      this.grumpy = false;
    }, 60_000);
  }

  private huffOff() {
    this.pokeTimes = [];
    this.grumpy = false;
    // Ends the current visit only; unlike a right-click dismissal the pet
    // still returns on a later scheduled visit.
    this.clearVisitTimers();
    this.scheduledVisiting = false;
    this.armArrival(
      lobsterLook.randomBetween(this.visitRng, plans.VISIT_GAP_MS[0], plans.VISIT_GAP_MS[1]),
    );
  }

  // Long runs earn solidarity: after 10 minutes of busy the pet settles
  // into a quiet waiting pose until the run ends.
  private trackVigil() {
    if (this.vigilTimer !== null) {
      window.clearTimeout(this.vigilTimer);
      this.vigilTimer = null;
    }
    if (this.mode === "busy") {
      this.vigilTimer = window.setTimeout(() => {
        this.vigilTimer = null;
        this.vigil = true;
        this.clearActTimers();
        this.act = null;
      }, 600_000);
    } else {
      this.vigil = false;
    }
  }

  // The pet watches your pointer: facing follows it between acts. Throttled,
  // idle-only, and inert under reduced motion or while acting.
  private readonly handleGaze = (event: PointerEvent) => {
    if (this.presence !== "in" || this.act !== null || this.vigil || plans.prefersReducedMotion()) {
      return;
    }
    const now = Date.now();
    if (now - this.lastGazeAt < 120) {
      return;
    }
    this.lastGazeAt = now;
    const sprite = this.querySelector(".lobster-pet:not(.lobster-pet--shell)");
    if (!sprite) {
      return;
    }
    const rect = sprite.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const facing: 1 | -1 = event.clientX < centerX ? -1 : 1;
    if (facing !== this.facing) {
      this.facing = facing;
    }
  };

  // Right-click shoos the pet away for the rest of this page load.
  private readonly handleShoo = (event: Event) => {
    event.preventDefault();
    this.dismissed = true;
    dex.recordLobsterShoo();
  };

  private clearActTimers() {
    for (const timer of [this.idleTimer, this.actEndTimer, this.enterTimer]) {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    }
    this.idleTimer = null;
    this.actEndTimer = null;
    this.enterTimer = null;
  }

  private clearVisitTimers() {
    for (const timer of [this.visitTimer, this.leaveTimer]) {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    }
    this.visitTimer = null;
    this.leaveTimer = null;
  }

  // ---- Visit schedule ----

  private scheduleVisits() {
    this.clearVisitTimers();
    this.scheduledVisiting = false;
    // A shy share of loads never visits on their own; offline still summons.
    if (this.visitRng() < plans.VISIT_SHY_CHANCE) {
      return;
    }
    const tuning = dex.LOBSTER_FAMILIARITY_TUNING[this.familiarity.tier];
    this.armArrival(
      lobsterLook.randomBetween(
        this.visitRng,
        plans.VISIT_FIRST_DELAY_MS[0],
        plans.VISIT_FIRST_DELAY_MS[1],
      ) * tuning.firstDelayMul,
    );
  }

  private armArrival(delayMs: number) {
    this.visitTimer = window.setTimeout(() => {
      this.visitTimer = null;
      this.rollPerch();
      this.scheduledVisiting = true;
      this.armDeparture(
        lobsterLook.randomBetween(this.visitRng, plans.VISIT_STAY_MS[0], plans.VISIT_STAY_MS[1]) *
          dex.LOBSTER_FAMILIARITY_TUNING[this.familiarity.tier].stayMul,
      );
    }, delayMs);
  }

  private armDeparture(stayMs: number) {
    this.visitTimer = window.setTimeout(() => {
      this.visitTimer = null;
      this.scheduledVisiting = false;
      const tuning = dex.LOBSTER_FAMILIARITY_TUNING[this.familiarity.tier];
      const waryMul = this.familiarity.wary ? dex.LOBSTER_FAMILIARITY_TUNING.waryGapMul : 1;
      this.armArrival(
        lobsterLook.randomBetween(this.visitRng, plans.VISIT_GAP_MS[0], plans.VISIT_GAP_MS[1]) *
          tuning.gapMul *
          waryMul,
      );
    }, stayMs);
  }

  // ---- Ledge traffic (scheduling lives in LobsterLedgeTraffic) ----

  // The resident notices traffic: it turns toward a passer's entry side,
  // then follows it out with a mid-crossing flip. Scuttle owns facing while
  // it walks; anything else can turn its head.
  private watchTraffic(facing: 1 | -1) {
    if (this.presence === "in" && this.act !== "scuttle" && !this.vigil) {
      this.facing = facing;
    }
  }

  private reactToPasser() {
    const reaction =
      this.familiarity.tier === "friend" ? "wave" : this.familiarity.tier === "shy" ? "peek" : null;
    if (
      reaction === null ||
      this.presence !== "in" ||
      this.logoPerched ||
      this.act !== null ||
      this.vigil ||
      this.mode !== "idle" ||
      plans.prefersReducedMotion()
    ) {
      return;
    }
    this.performAct(reaction);
  }

  // Each arrival re-rolls either the standard side zone or compact bar zone.
  // Both visit profiles render above the footer divider.
  private rollPerch() {
    this.anchor = this.visitRng() < 0.6 ? "ledge" : "bar";
    this.setAttribute("data-spot", this.anchor);
    const zone = this.currentZone();
    this.spotPct = Math.round(lobsterLook.randomBetween(this.visitRng, zone[0], zone[1]));
    this.facing = this.visitRng() < 0.5 ? 1 : -1;
  }

  private currentZone(): readonly [number, number] {
    if (this.anchor === "bar") {
      return plans.BAR_ZONE;
    }
    const side = this.look?.side ?? "right";
    return plans.SPOT_ZONES[side];
  }

  private scheduleNextAct() {
    // Guard here, not just at activation: the visibilitychange resume path
    // must also stay inert for reduced-motion users and departed pets.
    if (
      !this.look ||
      this.presence !== "in" ||
      this.logoPerched ||
      this.vigil ||
      this.traffic.passer !== null ||
      this.idleTimer !== null ||
      this.actEndTimer !== null ||
      plans.prefersReducedMotion()
    ) {
      return;
    }
    const profile = plans.resolveLobsterActProfile(this.mode, this.look.personality);
    if (!profile) {
      return;
    }
    const delay = lobsterLook.randomBetween(this.rng, profile.delayMs[0], profile.delayMs[1]);
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      const nextProfile = plans.resolveLobsterActProfile(this.mode, this.look?.personality ?? null);
      // A crossing pauses the fidget loop: the pet is busy watching. The
      // traffic controller's passer-end hook restarts scheduling.
      if (
        !nextProfile ||
        document.hidden ||
        this.presence !== "in" ||
        this.traffic.passer !== null
      ) {
        return;
      }
      if (this.moltPlanned && !this.molted && this.mode === "idle") {
        this.performAct("molt");
        return;
      }
      this.performAct(lobsterLook.pickWeighted(this.rng, nextProfile.acts));
    }, delay);
  }

  private performAct(act: plans.LobsterPetAct, presenceOwner: "vigil" | null = null) {
    this.clearActTimers();
    // The active outcome chain carries its sole presence owner across linked
    // acts; overrides, forced departures, and the terminal act release it.
    this.outcomePresenceOwner = presenceOwner;
    this.entering = false;
    if (act === "scuttle") {
      this.startScuttle();
    }
    this.act = act;
    this.actEndTimer = window.setTimeout(() => {
      this.actEndTimer = null;
      this.act = null;
      if (act === "molt") {
        this.completeMolt();
      }
      if (act === "droop") {
        // Bad news gets processed lobster-style: tidy the ledge, then move on.
        this.performAct("sweep", presenceOwner);
        return;
      }
      this.outcomePresenceOwner = null;
      if (this.wantsVisible()) {
        this.scheduleNextAct();
      }
    }, plans.LOBSTER_PET_ACT_DURATION_MS[act]);
  }

  // Shedding: the old shell stays behind and slowly fades while the pet
  // steps aside one size bigger. Once per load.
  private completeMolt() {
    this.molted = true;
    if (this.look) {
      const tiers = [1.7, 2, 2.5];
      const index = tiers.indexOf(this.look.scale);
      // The shed shell keeps the true pre-molt size; a max-tier pet sheds a
      // max-tier shell.
      this.shellScale = this.look.scale;
      this.look = {
        ...this.look,
        scale: expectDefined(
          tiers[Math.min(index + 1, tiers.length - 1)],
          "lobster molt size tier",
        ),
      };
    }
    this.shellSpotPct = this.spotPct;
    this.shellVisible = true;
    const zone = this.currentZone();
    this.spotPct = Math.min(
      zone[1],
      Math.max(zone[0], this.spotPct + (this.facing === 1 ? 9 : -9)),
    );
    if (this.shellTimer !== null) {
      window.clearTimeout(this.shellTimer);
    }
    this.shellTimer = window.setTimeout(() => {
      this.shellTimer = null;
      this.shellVisible = false;
    }, 60_000);
  }

  private startScuttle() {
    if (!this.look) {
      return;
    }
    const zone = this.currentZone();
    let target = Math.round(lobsterLook.randomBetween(this.rng, zone[0], zone[1]));
    // A same-spot walk reads as a glitch; nudge to the other zone edge.
    if (Math.abs(target - this.spotPct) < 4) {
      target =
        Math.abs(zone[0] - this.spotPct) > Math.abs(zone[1] - this.spotPct) ? zone[0] : zone[1];
    }
    this.facing = target < this.spotPct ? -1 : 1;
    this.spotPct = target;
  }

  override render() {
    const look = this.look;
    if (!look) {
      return nothing;
    }
    const identity = this.identity;
    const flavor = identity?.elder
      ? "old as the tides"
      : identity?.oldFriend
        ? "an old friend"
        : null;
    return lobsterLook.renderLobsterPetScene({
      look,
      mode: this.mode,
      presence: this.presence,
      logoPerched: this.logoPerched,
      shellVisible: this.shellVisible,
      visitsEnabled: this.visitsEnabled,
      dismissed: this.dismissed,
      passer: this.traffic.passer
        ? {
            kind: this.traffic.passer.kind,
            direction: this.traffic.passer.direction,
            crossMs: this.traffic.passerCrossMs(),
          }
        : null,
      twinPlanned: this.twinPlanned,
      anniversary: this.anniversary,
      entering: this.entering,
      entrance: this.entrance,
      grumpy: this.grumpy,
      vigil: this.vigil,
      elder: identity?.elder ?? false,
      act: this.act,
      zone: this.currentZone(),
      spotPct: this.spotPct,
      facing: this.facing,
      anchor: this.anchor,
      barMaxScale: plans.BAR_MAX_SCALE,
      shellScale: this.shellScale,
      shellSpotPct: this.shellSpotPct,
      familiarityVisits: this.familiarity.visits,
      seed: this.seed,
      movingDay: this.movingDay,
      sailorDay: this.sailorDay,
      nameOverride: identity ? plans.lobsterLoadDisplayName(identity, this.seed) : null,
      flavor,
      bottle: this.traffic.bottle(),
      onPointerDown: this.handleHoldStart,
      onPointerUp: this.handleHoldEnd,
      onPointerCancel: this.handleHoldCancel,
      onContextMenu: this.handleShoo,
      onBottleOpen: this.traffic.openBottle,
    });
  }
}
if (!customElements.get("openclaw-lobster-pet")) {
  customElements.define("openclaw-lobster-pet", LobsterPet);
}
