import { css } from "lit";

export const terminalPanelStyles = css`
  :host {
    position: fixed;
    z-index: 60;
    color: var(--text, #d7dae0);
    font-family: var(--font-sans, system-ui, sans-serif);
  }
  .tp {
    position: fixed;
    display: flex;
    flex-direction: column;
    background: var(--bg, #0e1015);
    overflow: hidden;
  }
  .tp--bottom {
    left: var(--shell-nav-width, 0);
    right: 0;
    bottom: 0;
    border-top: 1px solid var(--border, #262b34);
    --tp-session-menu-max-height: calc(var(--tp-panel-height) - 44px);
  }
  .tp--right {
    top: var(--shell-topbar-height, 0);
    right: 0;
    bottom: 0;
    border-left: 1px solid var(--border, #262b34);
    --tp-session-menu-max-height: calc(100dvh - var(--shell-topbar-height, 0px) - 44px);
  }
  .tp--fullscreen {
    inset: 0;
  }
  .tp-resizer {
    position: absolute;
    z-index: 2;
    background: transparent;
  }
  .tp-resizer:hover {
    background: var(--accent, #ff5c5c);
    opacity: 0.5;
  }
  .tp-resizer--bottom {
    top: 0;
    left: 0;
    right: 0;
    height: 5px;
    cursor: ns-resize;
  }
  .tp-resizer--right {
    top: 0;
    bottom: 0;
    left: 0;
    width: 5px;
    cursor: ew-resize;
  }
  .tp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 6px 0 4px;
    border-bottom: 1px solid var(--border, #262b34);
    background: var(--bg, #0e1015);
    min-height: 36px;
  }
  .tp-tabs {
    --track-width: 0;
    display: block;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tp-tabs::part(nav) {
    display: flex;
    align-items: stretch;
    gap: 1px;
  }
  .tp-tabs::part(body) {
    display: none;
  }
  .tp-tabs::-webkit-scrollbar {
    display: none;
  }
  .tp-tab::part(base) {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 10px;
    height: 36px;
    color: var(--muted, #8a919e);
    white-space: nowrap;
    font-size: 12.5px;
    border-bottom: 2px solid transparent;
    transition:
      color 0.12s ease,
      background 0.12s ease;
  }
  .tp-tab:hover::part(base) {
    color: var(--text, #d7dae0);
    background: color-mix(in srgb, var(--text, #d7dae0) 6%, transparent);
  }
  .tp-tab[active]::part(base) {
    color: var(--text, #d7dae0);
    border-bottom-color: var(--accent, #ff5c5c);
  }
  .tp-tab.is-exited::part(base) {
    opacity: 0.55;
  }
  .tp-tab.is-connecting .tp-tab__icon {
    animation: tp-pulse 1.2s ease-in-out infinite;
  }
  .tp-tab__icon {
    display: inline-flex;
    color: var(--accent, #4ec9a8);
  }
  .tp-tab.is-exited .tp-tab__icon {
    color: var(--muted, #8a919e);
  }
  .tp-tab__label {
    font-variant-numeric: tabular-nums;
  }
  .tp-tab__status {
    font-size: 11px;
    color: var(--muted, #8a919e);
  }
  .tp-tab__close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    align-self: center;
    flex: 0 0 26px;
    width: 26px;
    height: 26px;
    opacity: 0;
    border: none;
    background: transparent;
    color: var(--muted, #8a919e);
    border-radius: 6px;
    padding: 0;
  }
  :where(.tp-tab:hover, .tp-tab[active]) + .tp-tab__close {
    opacity: 0.7;
  }
  .tp-tab__close:hover,
  .tp-tab__close:focus-visible {
    opacity: 1;
  }
  .tp-new,
  .tp-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none;
    background: transparent;
    color: var(--muted, #8a919e);
    border-radius: 6px;
    padding: 0;
  }
  .tp-new {
    align-self: center;
  }
  .tp-tab__close:hover,
  .tp-new:hover,
  .tp-icon:hover {
    background: color-mix(in srgb, var(--text, #d7dae0) 12%, transparent);
    color: var(--text, #d7dae0);
  }
  .tp-icon.is-active {
    color: var(--text, #d7dae0);
    background: color-mix(in srgb, var(--text, #d7dae0) 10%, transparent);
  }
  .tp-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    padding-left: 6px;
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
  .tp-empty,
  .tp-error {
    padding: 10px 12px;
    font-size: 12px;
    color: var(--muted, #8a919e);
  }
  .tp-error {
    color: var(--danger, #ff6b6b);
  }
  @keyframes tp-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes tp-pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tp-connecting__spinner,
    .tp-tab.is-connecting .tp-tab__icon {
      animation: none;
    }
  }
`;
