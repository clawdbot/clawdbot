import { css } from "lit";

export const terminalPanelStyles = css`
  .tp--bottom {
    left: var(--shell-nav-width, 0);
    right: 0;
    bottom: 0;
    --tp-session-menu-max-height: calc(var(--tp-panel-height) - 44px);
  }
  .tp--right {
    top: var(--shell-topbar-height, 0);
    right: 0;
    bottom: 0;
    --tp-session-menu-max-height: calc(100dvh - var(--shell-topbar-height, 0px) - 44px);
  }
  .tp--main {
    /* Main mode owns the content region; later sibling docks may overlay it. */
    top: var(--shell-topbar-height, 0);
    left: var(--shell-nav-width, 0);
    right: 0;
    bottom: 0;
    --tp-session-menu-max-height: calc(100dvh - var(--shell-topbar-height, 0px) - 44px);
  }
  .tp--fullscreen {
    inset: 0;
  }
  .tp-header {
    background: var(--bg, #0e1015);
  }
  .tp-icon.is-active {
    color: var(--text, #d7dae0);
    background: color-mix(in srgb, var(--text, #d7dae0) 10%, transparent);
  }
  .tp-dock-modes {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .tp-session-picker {
    position: relative;
  }
  .tp-session-menu {
    position: absolute;
    z-index: 4;
    top: 31px;
    right: 0;
    width: min(360px, calc(100vw - 24px));
    max-height: min(420px, var(--tp-session-menu-max-height));
    overflow-y: auto;
    border: 1px solid var(--border, #262b34);
    border-radius: 8px;
    background: var(--bg, #0e1015);
    box-shadow: 0 12px 30px rgb(0 0 0 / 35%);
    padding: 6px;
  }
  .tp-session-menu__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 6px 7px;
    color: var(--text, #d7dae0);
    font-size: 12px;
    font-weight: 600;
  }
  .tp-session-refresh {
    border: 0;
    background: transparent;
    color: var(--accent, #ff5c5c);
    font: inherit;
    font-weight: 500;
    padding: 2px 4px;
  }
  .tp-session {
    display: grid;
    grid-template-columns: minmax(70px, auto) minmax(100px, 1fr) auto;
    align-items: center;
    gap: 8px;
    width: 100%;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text, #d7dae0);
    padding: 7px 8px;
    text-align: left;
  }
  .tp-session:not(:disabled):hover,
  .tp-session:not(:disabled):focus-visible {
    background: color-mix(in srgb, var(--text, #d7dae0) 10%, transparent);
  }
  .tp-session:disabled {
    opacity: 0.55;
  }
  .tp-session__agent {
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
    font-weight: 600;
  }
  .tp-session__cwd {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted, #8a919e);
    font:
      11px ui-monospace,
      SFMono-Regular,
      "SF Mono",
      Menlo,
      Consolas,
      "Liberation Mono",
      monospace;
  }
  .tp-session__state {
    color: var(--muted, #8a919e);
    font-size: 11px;
    white-space: nowrap;
  }
  .tp-session-empty {
    padding: 10px 8px;
    color: var(--muted, #8a919e);
    font-size: 12px;
  }
  .tp-viewport {
    position: relative;
    flex: 1;
    min-height: 0;
    background: var(--bg, #0e1015);
  }
  .tp-host {
    position: absolute;
    inset: 0;
    z-index: 0;
    padding: 6px 8px;
    caret-color: transparent;
  }
  .tp-connecting {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--muted, #8a919e);
    background: color-mix(in srgb, var(--bg, #0e1015) 88%, transparent);
    font-size: 12px;
    pointer-events: none;
  }
  .tp-connecting__spinner {
    width: 16px;
    height: 16px;
    border: 2px solid color-mix(in srgb, var(--accent, #ff5c5c) 24%, transparent);
    border-top-color: var(--accent, #ff5c5c);
    border-radius: 50%;
    animation: tp-spin 0.8s linear infinite;
  }
  .tp-error {
    padding: 10px 12px;
    font-size: 12px;
    color: var(--danger, #ff6b6b);
  }
  @keyframes tp-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tp-connecting__spinner {
      animation: none;
    }
  }
`;
