// Control UI module implements theme transition behavior.
import type { ResolvedTheme } from "./theme.ts";

export type ThemeTransitionContext = {
  element?: HTMLElement | null;
  pointerClientX?: number;
  pointerClientY?: number;
};

type ThemeTransitionOptions = {
  nextTheme: ResolvedTheme;
  applyTheme: () => void;
  // Retained so callers from stacked slices can keep passing pointer metadata
  // while theme switching remains an immediate, non-animated update here.
  context?: ThemeTransitionContext;
  currentTheme?: ResolvedTheme | null;
};

const cleanupThemeTransition = (root: HTMLElement) => {
  root.classList.remove("theme-transition");
  root.style.removeProperty("--theme-switch-x");
  root.style.removeProperty("--theme-switch-y");
};

export const startThemeTransition = ({
  nextTheme,
  applyTheme,
  currentTheme,
}: ThemeTransitionOptions) => {
  if (currentTheme === nextTheme) {
    // Even when the resolved palette is unchanged (e.g. system->dark on a dark OS),
    // we still need to persist the user's explicit selection immediately.
    applyTheme();
    return;
  }

  const documentReference = globalThis.document ?? null;
  if (!documentReference) {
    applyTheme();
    return;
  }

  const root = documentReference.documentElement;
  // Theme updates should be visible immediately on click with no transition lag.
  applyTheme();
  cleanupThemeTransition(root);
};
