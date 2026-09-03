// Keep the shipped single-bar forms and the doubled full-width form observed
// in provider output identical across tool recovery and visible-text filtering.
export const DEEPSEEK_DSML_MARKERS = ["|", "｜", "｜｜"].map((bar) => `${bar}DSML${bar}`);
export const DEEPSEEK_DSML_MARKER_PATTERN = `(${DEEPSEEK_DSML_MARKERS.map((marker) =>
  marker.replaceAll("|", "\\|"),
).join("|")})`;
