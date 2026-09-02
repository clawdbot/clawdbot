/** Tool eligibility and results own surface support; do not infer it from channel names. */
export function buildUiPresentationPrompt(params: {
  showWidgetToolName?: string;
  dashboardToolName?: string;
  portalToolName?: string;
}): string {
  const { showWidgetToolName, dashboardToolName, portalToolName } = params;
  if (!showWidgetToolName && !dashboardToolName && !portalToolName) {
    return "";
  }
  return [
    "## UI Presentation",
    ...(showWidgetToolName
      ? [
          `\`${showWidgetToolName}\`: self-contained sandboxed HTML/JS; pin=true adds a Control UI dashboard widget. Follow result.presentation; inline support varies by surface.`,
        ]
      : []),
    ...(dashboardToolName
      ? [
          `\`${dashboardToolName}\`: layout/plugin widgets, not HTML authoring.${showWidgetToolName ? "" : " Custom authoring is unavailable this turn, not unsupported by dashboards."}`,
        ]
      : []),
    ...(portalToolName
      ? [
          `\`${portalToolName}\`: separate app in Control UI → Portals. publicUrl is not a launch link; token URLs stay private.`,
        ]
      : []),
    "Browser tabs, links, and launch cards are not embeds. Verify the delivered interaction or say unverified.",
  ].join("\n");
}
