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
  .desktop-connecting {
    position: absolute;
    inset: 0;
    /* Status overlay only; clicks must reach the take-control surface below. */
    pointer-events: none;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 14px;
    background: color-mix(in srgb, var(--bg) 94%, transparent);
    color: var(--muted);
    font-size: 12px;
    text-align: center;
  }
  .desktop-connecting__monitor {
    display: inline-flex;
    width: 38px;
    height: 38px;
    color: color-mix(in srgb, var(--text) 76%, var(--muted));
    animation: desktop-monitor-glow 1.8s ease-in-out infinite;
  }
  .desktop-connecting__monitor svg {
    width: 100%;
    height: 100%;
    stroke-width: 1.25;
  }
  .desktop-connecting__copy {
    display: flex;
    align-items: baseline;
    gap: 1px;
  }
  .desktop-connecting__dots {
    display: inline-flex;
    width: 16px;
    gap: 1px;
  }
  .desktop-connecting__dot {
    width: 2px;
    height: 2px;
    border-radius: 50%;
    animation: desktop-traveling-dot 1.2s ease-in-out infinite;
    background: currentColor;
    opacity: 0.25;
  }
  .desktop-connecting__dot:nth-child(2) {
    animation-delay: 160ms;
  }
  .desktop-connecting__dot:nth-child(3) {
    animation-delay: 320ms;
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
  @keyframes desktop-monitor-glow {
    50% {
      color: var(--text);
      filter: drop-shadow(0 0 7px color-mix(in srgb, var(--accent) 32%, transparent));
    }
  }
  @keyframes desktop-traveling-dot {
    40% {
      opacity: 1;
      transform: translateY(-2px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .desktop-app-button__icon--launching,
    .desktop-connecting__monitor,
    .desktop-connecting__dot {
      animation: none;
    }
    .desktop-connecting__dot {
      opacity: 0.65;
    }
  }
`;
