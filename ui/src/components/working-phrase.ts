// Whimsical long-wait status word ("Clawing…") for the chat working row.
// Silent for the first stretch of a run, then rotates through crab-themed
// gerunds so long quiet runs feel alive without claiming progress data the
// UI does not have. Decorative only — the row keeps its sr-only "Working…".
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { PollController } from "../lit/poll-controller.ts";

const PHRASE_KEYS = [
  "shelling",
  "scuttling",
  "clawing",
  "pinching",
  "molting",
  "bubbling",
  "tiding",
  "reefing",
  "cracking",
  "sifting",
  "brining",
  "nautiling",
  "krilling",
  "barnacling",
  "lobstering",
  "tidepooling",
  "pearling",
  "snapping",
  "surfacing",
] as const;

/** Quiet grace period before the first phrase appears. Mirrored as literals
 * in working-phrase.test.ts (knip forbids test-only exports). */
const WORKING_PHRASE_SHOW_AFTER_MS = 30_000;
/** How long each phrase holds before rotating to the next. */
const WORKING_PHRASE_ROTATE_EVERY_MS = 45_000;

// FNV-1a, matching the stance picker: deterministic per seed.
function fnvHash(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Constant-time stride walk over the phrase list: any stride in
 * [1, len-1] guarantees adjacent buckets differ, and with a prime-length
 * list (currently 19) every stride cycles through all phrases before
 * repeating. Must stay O(1) in bucket — ChatItem.startedAt can be an
 * arbitrarily old timestamp, and this runs on a one-second poll. */
function displayedPhraseIndex(seed: string, bucket: number): number {
  const length = PHRASE_KEYS.length;
  const offset = fnvHash(`${seed}:offset`) % length;
  const stride = 1 + (fnvHash(`${seed}:stride`) % (length - 1));
  return (offset + bucket * stride) % length;
}

class WorkingPhrase extends OpenClawLightDomContentsElement {
  @property({ type: Number }) startMs: number | null = null;
  @property() seed = "";

  private readonly polling = new PollController(this, 1_000, () => this.requestUpdate(), false);

  override connectedCallback() {
    super.connectedCallback();
    this.syncTimer();
  }

  override updated() {
    this.syncTimer();
  }

  private syncTimer() {
    if (this.isConnected && this.startMs != null) {
      this.polling.start();
    } else {
      this.polling.stop();
    }
  }

  override render() {
    if (this.startMs == null) {
      return nothing;
    }
    const elapsed = Date.now() - this.startMs;
    if (elapsed < WORKING_PHRASE_SHOW_AFTER_MS) {
      return nothing;
    }
    const sinceShown = elapsed - WORKING_PHRASE_SHOW_AFTER_MS;
    const bucket = Math.floor(sinceShown / WORKING_PHRASE_ROTATE_EVERY_MS);
    const index = displayedPhraseIndex(this.seed, bucket);
    return html`<span>·</span> ${t(`chat.progressLabels.${PHRASE_KEYS[index]}`)}…`;
  }
}

if (!customElements.get("openclaw-working-phrase")) {
  customElements.define("openclaw-working-phrase", WorkingPhrase);
}
