import { describe, expect, it } from "vitest";
import { composeTerminalIntroBanner } from "./intro-banner.js";

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
    const banner = composeTerminalIntroBanner();

    expect(banner).toBe(
      `\r\n\x1b[33mWelcome to the Claw.\x1b[0m\r\n\r\n\x1b[91m${EXPECTED_ART.join("\r\n")}\r\n\r\n\x1b[0m`,
    );
    expect(banner.startsWith("\r\n\x1b[33mWelcome to the Claw.\x1b[0m")).toBe(true);
    expect(banner.endsWith("\r\n\r\n\x1b[0m")).toBe(true);
    expect(banner.replaceAll("\r\n", "")).not.toContain("\n");
  });
});
