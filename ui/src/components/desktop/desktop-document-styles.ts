import { css } from "lit";

export const desktopDocumentStyles = css`
  /* The inset sizes this to the viewport on its own. Do not reintroduce viewport
     height units: Android WebView hosts the Control UI in a container that
     resolves dvh/vh/svh/lvh to 0, which collapses the viewer to a blank page. */
  .desktop-document {
    position: fixed;
    inset: 0;
    display: flex;
    overflow: hidden;
    box-sizing: border-box;
    background: var(--bg);
  }
  .desktop-document .desktop-content {
    width: 100%;
  }
  .desktop-document .desktop-stage {
    width: 100%;
  }
  .desktop-touch-toolbar {
    position: absolute;
    z-index: 3;
    right: 12px;
    bottom: max(12px, env(safe-area-inset-bottom));
    left: 12px;
    display: flex;
    width: max-content;
    max-width: calc(100% - 24px);
    align-items: center;
    justify-content: center;
    gap: 4px;
    margin: 0 auto;
    padding: 5px;
    border: 1px solid color-mix(in srgb, var(--text) 16%, transparent);
    border-radius: 14px;
    background: color-mix(in srgb, var(--bg) 84%, transparent);
    box-shadow: 0 8px 28px rgb(0 0 0 / 35%);
    backdrop-filter: blur(16px);
  }
  .desktop-touch-action {
    display: inline-flex;
    min-width: 48px;
    height: 44px;
    align-items: center;
    justify-content: center;
    gap: 5px;
    border: 0;
    border-radius: 10px;
    padding: 0 9px;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 11px;
  }
  .desktop-touch-action[aria-pressed="true"] {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }
  .desktop-touch-action:focus-visible {
    outline: 2px solid var(--focus, var(--accent));
    outline-offset: 1px;
  }
  .desktop-touch-action__icon {
    display: inline-flex;
    width: 18px;
    height: 18px;
  }
  .desktop-touch-action__icon svg {
    width: 100%;
    height: 100%;
    stroke-width: 1.8;
  }
  .desktop-keyboard-input {
    position: fixed;
    bottom: 0;
    left: 50%;
    width: 1px;
    height: 1px;
    border: 0;
    padding: 0;
    opacity: 0;
    pointer-events: none;
  }
  @media (max-width: 430px) {
    .desktop-touch-action {
      min-width: 44px;
      padding: 0 7px;
    }
    .desktop-touch-action__label {
      display: none;
    }
  }
`;
