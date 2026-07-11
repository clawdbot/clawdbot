// Styles for <openclaw-browser-panel>. Kept beside the component to keep the
// panel logic readable; visual language mirrors the operator terminal dock.
import { css } from "lit";

export const browserPanelStyles = css`
  :host {
    position: fixed;
    z-index: 60;
    color: var(--text, #d7dae0);
    font-family: var(--font-sans, system-ui, sans-serif);
  }
  .bp {
    position: fixed;
    display: flex;
    flex-direction: column;
    background: var(--bg, #0e1015);
    overflow: hidden;
  }
  /* Docked panels get a single hairline separator on the inner edge so they
     read as layout, not as a floating card. The browser dock yields to the
     terminal dock's reserved edges so the two panels tile instead of
     overlapping when both are open. */
  .bp--bottom {
    left: var(--shell-nav-width, 0);
    right: var(--oc-terminal-reserve-right, 0px);
    bottom: var(--oc-terminal-reserve-bottom, 0px);
    border-top: 1px solid var(--border, #262b34);
  }
  .bp--right {
    top: var(--shell-topbar-height, 0);
    right: var(--oc-terminal-reserve-right, 0px);
    bottom: var(--oc-terminal-reserve-bottom, 0px);
    border-left: 1px solid var(--border, #262b34);
  }
  .bp-resizer {
    position: absolute;
    z-index: 2;
    background: transparent;
  }
  .bp-resizer:hover {
    background: var(--accent, #ff5c5c);
    opacity: 0.5;
  }
  .bp-resizer--bottom {
    top: 0;
    left: 0;
    right: 0;
    height: 5px;
    cursor: ns-resize;
  }
  .bp-resizer--right {
    top: 0;
    bottom: 0;
    left: 0;
    width: 5px;
    cursor: ew-resize;
  }
  .bp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 6px 0 4px;
    border-bottom: 1px solid var(--border, #262b34);
    min-height: 36px;
  }
  .bp-tabs {
    display: flex;
    align-items: stretch;
    gap: 1px;
    overflow-x: auto;
    scrollbar-width: none;
    min-width: 0;
  }
  .bp-tabs::-webkit-scrollbar {
    display: none;
  }
  .bp-tab {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 10px;
    height: 36px;
    max-width: 220px;
    color: var(--muted, #8a919e);
    white-space: nowrap;
    font-size: 12.5px;
    border-bottom: 2px solid transparent;
    cursor: default;
    transition:
      color 0.12s ease,
      background 0.12s ease;
  }
  .bp-tab:hover {
    color: var(--text, #d7dae0);
    background: color-mix(in srgb, var(--text, #d7dae0) 6%, transparent);
  }
  .bp-tab.is-active {
    color: var(--text, #d7dae0);
    border-bottom-color: var(--accent, #ff5c5c);
  }
  .bp-tab__label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bp-tab__close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    opacity: 0;
    border: none;
    background: transparent;
    color: inherit;
    border-radius: 4px;
    padding: 0;
  }
  .bp-tab:hover .bp-tab__close,
  .bp-tab.is-active .bp-tab__close {
    opacity: 0.7;
  }
  .bp-new,
  .bp-icon {
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
  .bp-new {
    align-self: center;
    flex: none;
  }
  .bp-tab__close:hover,
  .bp-new:hover,
  .bp-icon:hover {
    background: color-mix(in srgb, var(--text, #d7dae0) 12%, transparent);
    color: var(--text, #d7dae0);
  }
  .bp-icon.is-active {
    color: var(--accent, #ff5c5c);
    background: color-mix(in srgb, var(--accent, #ff5c5c) 14%, transparent);
  }
  .bp-icon:disabled {
    opacity: 0.4;
  }
  .bp-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    padding-left: 6px;
    flex: none;
  }
  .bp-toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--border, #262b34);
  }
  .bp-url {
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-radius: 14px;
    background: color-mix(in srgb, var(--text, #d7dae0) 8%, transparent);
    color: var(--text, #d7dae0);
    font-size: 12.5px;
    font-family: inherit;
    outline: none;
    text-overflow: ellipsis;
  }
  .bp-url:focus {
    border-color: var(--accent, #ff5c5c);
    background: var(--bg, #0e1015);
  }
  .bp-annotatebar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    font-size: 12px;
    color: var(--muted, #8a919e);
    border-bottom: 1px solid var(--border, #262b34);
    background: color-mix(in srgb, var(--accent, #ff5c5c) 7%, transparent);
  }
  .bp-annotatebar__hint {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bp-btn {
    border: 1px solid var(--border, #262b34);
    background: transparent;
    color: var(--text, #d7dae0);
    font-size: 12px;
    font-family: inherit;
    border-radius: 6px;
    padding: 3px 10px;
  }
  .bp-btn:hover {
    background: color-mix(in srgb, var(--text, #d7dae0) 10%, transparent);
  }
  .bp-btn--primary {
    border-color: var(--accent, #ff5c5c);
    color: var(--accent, #ff5c5c);
  }
  .bp-viewport {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--bg, #0e1015);
    outline: none;
  }
  .bp-stage {
    position: relative;
    width: 100%;
  }
  .bp-shot {
    display: block;
    width: 100%;
    height: auto;
    user-select: none;
    -webkit-user-drag: none;
  }
  .bp-overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    touch-action: none;
  }
  .bp-overlay--annotate {
    cursor: crosshair;
  }
  .bp-overlay--inspect {
    cursor: default;
  }
  .bp-tooltip {
    position: absolute;
    z-index: 3;
    max-width: 320px;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border, #262b34);
    background: var(--bg, #0e1015);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
    font-size: 12px;
    pointer-events: none;
  }
  .bp-tooltip__title {
    display: flex;
    align-items: baseline;
    gap: 8px;
    justify-content: space-between;
  }
  .bp-tooltip__selector {
    color: var(--accent, #6ea8fe);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-all;
  }
  .bp-tooltip__size {
    color: var(--muted, #8a919e);
    white-space: nowrap;
  }
  .bp-tooltip__row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-top: 4px;
    color: var(--muted, #8a919e);
  }
  .bp-tooltip__row span:last-child {
    color: var(--text, #d7dae0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bp-status {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    height: 100%;
    padding: 20px;
    font-size: 12.5px;
    color: var(--muted, #8a919e);
    text-align: center;
  }
  .bp-note {
    padding: 6px 12px;
    font-size: 12px;
    color: var(--muted, #8a919e);
    border-bottom: 1px solid var(--border, #262b34);
  }
  .bp-note--error {
    color: var(--danger, #ff6b6b);
  }
  .bp-loading {
    position: absolute;
    top: 8px;
    right: 12px;
    z-index: 3;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    color: var(--muted, #8a919e);
    background: color-mix(in srgb, var(--bg, #0e1015) 80%, transparent);
    border: 1px solid var(--border, #262b34);
  }
`;
