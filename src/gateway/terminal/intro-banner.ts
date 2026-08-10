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

export function composeTerminalIntroBanner(cols: number): string {
  const headline = `\x1b[38;5;223mWelcome to the Claw.${RESET}`;
  const art = cols >= 40 ? `\x1b[38;5;216m${TERMINAL_INTRO_ART.join("\r\n")}\r\n\r\n` : "";
  return `\r\n${headline}\r\n\r\n${art}${RESET}`;
}
