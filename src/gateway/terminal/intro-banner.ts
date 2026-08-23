const RESET = "\x1b[0m";

const TERMINAL_INTRO_ART = [
  "          ..              ..",
  "        .●●:.:          • •●●",
  "       .●●●•●●          ●•●●●●",
  "       :●●●●●•  ..  ..  ●●●●●●.",
  "       .●●●●●::.:●••●:..•●●●●●",
  "        :●●●●.  :●●●●.  :●●●●.",
  "         •●●●•  ●●●●●● .●●●●:",
  "        ..:••●●•●●●●●●•●●••...",
  "       ..:●•●••●●●●●●●●••●●•:..",
  "       :.:•:•••●●●●●●●••••••:.:",
  "       .•. ●:..:●●●●●●...:• :•",
  "          .:.   ●●●●●●   .:.",
  "            .   ●●●●●•   .",
  "           .   :●●●●●●.   .",
  "              ●●●●●●●●●•",
  "              .::•::•::",
] as const;

// Always full art: open-time request.cols is the pre-fit boot grid (the client
// resizes immediately after open), so width gating keyed on it suppressed the
// art on real, wide terminals.
export function composeTerminalIntroBanner(): string {
  const headline = `\x1b[38;5;223mWelcome to the Claw.${RESET}`;
  const art = `\x1b[38;5;216m${TERMINAL_INTRO_ART.join("\r\n")}\r\n\r\n`;
  return `\r\n${headline}\r\n\r\n${art}${RESET}`;
}
