import { describe, expect, it } from "vitest";
import { composeTerminalIntroBanner, TERMINAL_INTRO_ART } from "./intro-banner.js";

const EXPECTED_ART = [
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

describe("composeTerminalIntroBanner", () => {
  it("composes the exact colored CRLF intro and resets ANSI state", () => {
    const banner = composeTerminalIntroBanner(80);

    expect(TERMINAL_INTRO_ART).toEqual(EXPECTED_ART);
    expect(banner).toBe(
      `\r\n\x1b[38;5;223mWelcome to the Claw.\x1b[0m\r\n\r\n\x1b[38;5;216m${TERMINAL_INTRO_ART.join("\r\n")}\r\n\r\n\x1b[0m`,
    );
    expect(banner.startsWith("\r\n\x1b[38;5;223mWelcome to the Claw.\x1b[0m")).toBe(true);
    expect(banner.endsWith("\r\n\r\n\x1b[0m")).toBe(true);
    expect(banner.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("emits only the headline below 40 columns", () => {
    expect(composeTerminalIntroBanner(39)).toBe(
      "\r\n\x1b[38;5;223mWelcome to the Claw.\x1b[0m\r\n\r\n\x1b[0m",
    );
  });
});
