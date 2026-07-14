import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { CONTROL_UI_BUILD_INFO } from "../../build-info.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderAbout, type AboutCommitCopyState } from "./view.ts";

const COPY_RESULT_VISIBLE_MS = 1800;
// Mirrors the about-clawd-wave animation duration in about.css so the wave
// class comes off right as the claw settles and the next poke can replay it.
const CLAWD_WAVE_MS = 1400;

class AboutPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private copyState: AboutCommitCopyState = "idle";
  @state() private clawdWaving = false;

  private copyResetTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private waveResetTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.gateway,
    (gateway, notify) => gateway.subscribe(notify),
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    if (this.copyResetTimer !== null) {
      globalThis.clearTimeout(this.copyResetTimer);
      this.copyResetTimer = null;
    }
    if (this.waveResetTimer !== null) {
      globalThis.clearTimeout(this.waveResetTimer);
      this.waveResetTimer = null;
    }
    super.disconnectedCallback();
  }

  private pokeClawd() {
    if (this.clawdWaving) {
      return;
    }
    this.clawdWaving = true;
    this.waveResetTimer = globalThis.setTimeout(() => {
      this.waveResetTimer = null;
      this.clawdWaving = false;
    }, CLAWD_WAVE_MS);
  }

  private async copyCommit() {
    const commit = CONTROL_UI_BUILD_INFO.commit;
    if (!commit || this.copyState === "copying") {
      return;
    }
    this.copyState = "copying";
    const copied = await copyToClipboard(commit);
    if (!this.isConnected) {
      return;
    }
    this.copyState = copied ? "copied" : "error";
    if (this.copyResetTimer !== null) {
      globalThis.clearTimeout(this.copyResetTimer);
    }
    this.copyResetTimer = globalThis.setTimeout(() => {
      this.copyResetTimer = null;
      this.copyState = "idle";
    }, COPY_RESULT_VISIBLE_MS);
  }

  override render() {
    const gatewaySnapshot = this.context.gateway.snapshot;
    const gatewayVersion = gatewaySnapshot.connected
      ? gatewaySnapshot.hello?.server?.version?.trim() || null
      : null;
    const body = renderAbout({
      buildInfo: CONTROL_UI_BUILD_INFO,
      gatewayVersion,
      copyState: this.copyState,
      onCopyCommit: () => void this.copyCommit(),
      clawdWaving: this.clawdWaving,
      onPokeClawd: () => this.pokeClawd(),
    });
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("about")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(body)}
    `;
  }
}

customElements.define("openclaw-about-page", AboutPage);
