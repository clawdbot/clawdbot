import { syncAnchoredOverlay } from "../../../components/anchored-overlay.ts";

const MOBILE_COMPOSER_OVERLAY_QUERY =
  "(max-width: 640px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)";

export function syncChatPickerOverlay(details: HTMLDetailsElement): void {
  // Mobile panels span the composer, so anchor to that stable box; desktop
  // panels stay attached to the individual trigger.
  const composerAnchor =
    typeof window.matchMedia === "function" &&
    window.matchMedia(MOBILE_COMPOSER_OVERLAY_QUERY).matches
      ? (details.closest(".agent-chat__input") ?? undefined)
      : undefined;
  syncAnchoredOverlay(details, "top", { alignment: "end", anchor: composerAnchor });
}
