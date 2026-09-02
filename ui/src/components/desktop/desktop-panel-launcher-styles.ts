import { css } from "lit";

export const desktopPanelLauncherStyles = css`
  .desktop-apps {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 3px;
  }
  .desktop-app-button,
  .desktop-toolbar-action {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 0;
    border-radius: 4px;
    padding: 5px 7px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    white-space: nowrap;
  }
  .desktop-app-button {
    color: var(--text);
  }
  .desktop-app-button:hover:not(:disabled),
  .desktop-toolbar-action:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text) 8%, transparent);
    color: var(--text);
  }
  .desktop-app-button:focus-visible,
  .desktop-toolbar-action:focus-visible {
    outline: 2px solid var(--focus, var(--accent));
    outline-offset: 1px;
  }
  .desktop-app-button:disabled,
  .desktop-toolbar-action:disabled {
    cursor: default;
    opacity: 0.55;
  }
  .desktop-app-button__icon {
    display: inline-flex;
    width: 15px;
    height: 15px;
  }
  .desktop-app-button__icon svg {
    width: 100%;
    height: 100%;
    stroke-width: 1.75;
  }
  .desktop-app-button__icon--launching {
    animation: desktop-app-launch 900ms linear infinite;
  }
  @keyframes desktop-app-launch {
    50% {
      opacity: 0.6;
      transform: rotate(180deg) scale(0.92);
    }
    100% {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .desktop-app-button__icon--launching {
      animation: none;
    }
  }
`;
