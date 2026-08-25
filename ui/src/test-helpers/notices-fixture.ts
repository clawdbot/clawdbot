import { html, render } from "lit";
import "../lib/toast.ts";

const variants = ["info", "success", "warning", "danger"] as const;

function callouts() {
  return variants.map(
    (variant) => html`<div class="callout ${variant === "warning" ? "warn" : variant}">
      <strong>${variant}</strong><br />Persistent inline context owned by this surface.
    </div>`,
  );
}

render(
  html`<style>
      .notice-fixture {
        box-sizing: border-box;
        max-width: 1320px;
        margin: 0 auto;
        padding: 40px;
        color: var(--text);
      }
      .notice-fixture__header {
        margin-bottom: 32px;
      }
      .notice-fixture__eyebrow,
      .notice-fixture__zone-code {
        color: var(--muted);
        font: 11px var(--mono);
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .notice-fixture h1 {
        margin: 8px 0;
        color: var(--text-strong);
        font-size: 30px;
      }
      .notice-fixture__intro {
        max-width: 760px;
        color: var(--muted);
        line-height: 1.6;
      }
      .notice-fixture__grid {
        display: grid;
        gap: 20px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .notice-fixture__zone {
        min-width: 0;
        padding: 20px;
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        background: var(--card);
      }
      .notice-fixture__zone h2 {
        margin: 5px 0 16px;
        color: var(--text-strong);
        font-size: 17px;
      }
      .notice-fixture__stack {
        display: grid;
        gap: 10px;
      }
      .notice-fixture__pane {
        position: relative;
        min-height: 250px;
        overflow: hidden;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg);
      }
      .notice-fixture__pane-topbar {
        height: 44px;
        border-bottom: 1px solid var(--border);
        background: var(--bg-elevated);
      }
      .notice-fixture__session-chips {
        display: grid;
        gap: 8px;
        justify-items: center;
        padding: 12px;
      }
      .notice-fixture__chip {
        display: flex;
        align-items: center;
        gap: 8px;
        max-width: calc(100% - 24px);
        padding: 7px 11px;
        border: 1px solid color-mix(in srgb, var(--tone) 34%, var(--border));
        border-radius: var(--radius-full);
        background: color-mix(in srgb, var(--tone) 10%, var(--popover));
        color: color-mix(in srgb, var(--tone) 82%, var(--text-strong));
        font-size: 12px;
      }
      .notice-fixture__composer {
        margin-top: 28px;
        padding: 12px;
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-lg);
        background: var(--bg-elevated);
      }
      .notice-fixture__composer-label {
        margin-bottom: 8px;
        color: var(--muted);
        font-size: 12px;
      }
      .notice-fixture__banner {
        padding: 11px 14px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--secondary);
      }
      .notice-fixture__toast-gallery {
        display: grid;
        gap: 10px;
      }
      .notice-fixture__toast-gallery .app-toast {
        position: relative;
        inset: auto;
        max-width: none;
        translate: none;
        opacity: 1;
      }
      .notice-fixture__modal {
        display: grid;
        place-items: center;
        min-height: 170px;
        border-radius: var(--radius-md);
        background: color-mix(in srgb, var(--overlay) 75%, transparent);
      }
      .notice-fixture__modal-card {
        width: min(420px, calc(100% - 32px));
        padding: 18px;
        border: 1px solid color-mix(in srgb, var(--warn) 34%, var(--border));
        border-radius: var(--radius-lg);
        background: var(--popover);
        box-shadow: var(--shadow-lg);
      }
      .notice-fixture__footer-row {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .notice-fixture__badge {
        min-width: 28px;
        height: 28px;
        display: grid;
        place-items: center;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--secondary);
      }
      @media (max-width: 768px) {
        .notice-fixture {
          padding: 20px 14px 360px;
        }
        .notice-fixture__grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
    <main class="notice-fixture">
      <header class="notice-fixture__header">
        <div class="notice-fixture__eyebrow">UX inventory fixture</div>
        <h1>Operator notices by zone</h1>
        <p class="notice-fixture__intro">
          All canonical toast, chip, banner, callout, modal and composer-owned notice shapes are
          visible together. Toggle <code>?theme=light</code> or <code>?theme=dark</code>.
        </p>
      </header>
      <div class="notice-fixture__grid">
        <section class="notice-fixture__zone">
          <div class="notice-fixture__zone-code">Zone A / M1</div>
          <h2>Pane-scoped notices</h2>
          <div class="notice-fixture__pane">
            <div class="notice-fixture__pane-topbar"></div>
            <div class="notice-fixture__session-chips">
              ${variants.map(
                (variant) =>
                  html`<div
                    class="notice-fixture__chip"
                    style=${`--tone: var(--${variant === "success" ? "ok" : variant === "warning" ? "warn" : variant})`}
                  >
                    <span>●</span><span>${variant}: session outcome near its pane</span
                    ><button class="btn btn--ghost btn--xs">×</button>
                  </div>`,
              )}
            </div>
          </div>
        </section>
        <section class="notice-fixture__zone">
          <div class="notice-fixture__zone-code">Zone B</div>
          <h2>Decision modal</h2>
          <div class="notice-fixture__modal">
            <div class="notice-fixture__modal-card">
              <strong>Exec approval needed</strong>
              <p class="muted">A persistent warning that requires an operator decision.</p>
              <button class="btn primary">Allow once</button> <button class="btn">Deny</button>
            </div>
          </div>
        </section>
        <section class="notice-fixture__zone">
          <div class="notice-fixture__zone-code">Zones C-D / M2-M3</div>
          <h2>Transcript and fixed composer</h2>
          <div class="notice-fixture__stack">
            <div class="chat-error" role="alert">
              <span class="chat-error__dot"></span
              ><span class="chat-error__content">Run failed with a recoverable error.</span>
            </div>
            <div class="notice-fixture__composer">
              <div class="notice-fixture__composer-label">Composer-owned, fixed in place</div>
              <div class="callout warn">You're offline. Messages will queue.</div>
            </div>
          </div>
        </section>
        <section class="notice-fixture__zone">
          <div class="notice-fixture__zone-code">Zone E / M1</div>
          <h2>Global toast variants</h2>
          <div class="notice-fixture__toast-gallery">
            ${variants.map(
              (variant) => html`<div
                class="app-toast app-toast--${variant}"
                data-active="true"
                role=${variant === "warning" || variant === "danger" ? "alert" : "status"}
              >
                <span class="app-toast__icon">●</span>
                <span class="app-toast__message">${variant}: global operator outcome</span>
                <button class="app-toast__dismiss">×</button>
              </div>`,
            )}
          </div>
        </section>
        <section class="notice-fixture__zone">
          <div class="notice-fixture__zone-code">Zone F</div>
          <h2>Global status banner</h2>
          <div class="notice-fixture__stack">
            <div class="notice-fixture__banner">
              Actions are unavailable while the Gateway reconnects.
            </div>
            <div class="callout danger">This view failed to load. Retry the route.</div>
          </div>
        </section>
        <section class="notice-fixture__zone">
          <div class="notice-fixture__zone-code">Inline inventory</div>
          <h2>Canonical callouts</h2>
          <div class="notice-fixture__stack">${callouts()}</div>
        </section>
        <section class="notice-fixture__zone">
          <div class="notice-fixture__zone-code">Zones G / M4</div>
          <h2>Persistent centers</h2>
          <div class="notice-fixture__stack">
            <div class="notice-fixture__footer-row">
              <span class="notice-fixture__badge">9</span
              ><span>Inbox: approvals, automations and system attention</span>
            </div>
            <div class="notice-fixture__footer-row">
              <span class="notice-fixture__badge">↻</span
              ><span>Update available, persistent until action</span>
            </div>
            <div class="sw-action-toast">Skill action running</div>
          </div>
        </section>
      </div>
      <openclaw-toast-host></openclaw-toast-host>
    </main>`,
  document.querySelector("#app")!,
);

const host = document.querySelector("openclaw-toast-host") as HTMLElement & {
  show: (options: {
    message: string;
    variant: (typeof variants)[number];
    durationMs: number;
  }) => void;
};
for (const variant of variants.slice(1)) {
  host.show({ message: `${variant}: global operator outcome`, variant, durationMs: 86_400_000 });
}
