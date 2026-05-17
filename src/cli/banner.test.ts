import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliBannerLine } from "./banner.js";

const readCliBannerTaglineModeMock = vi.hoisted(() => vi.fn());

vi.mock("./banner-config-lite.js", () => ({
  parseTaglineMode: (value: unknown) =>
    value === "random" || value === "default" || value === "off" ? value : undefined,
  readCliBannerTaglineMode: readCliBannerTaglineModeMock,
}));

beforeEach(() => {
  readCliBannerTaglineModeMock.mockReset();
  readCliBannerTaglineModeMock.mockReturnValue(undefined);
});

describe("formatCliBannerLine", () => {
  it("hides tagline text when cli.banner.taglineMode is off", () => {
    readCliBannerTaglineModeMock.mockReturnValue("off");

    const line = formatCliBannerLine("2026.3.7", {
      commit: "abc1234",
      env: { LANG: "en_US.UTF-8" },
      isTty: true,
      platform: "darwin",
      richTty: false,
    });

    expect(line).toBe("🦞 OpenClaw 2026.3.7 (abc1234)");
  });

  it("uses default tagline when cli.banner.taglineMode is default", () => {
    readCliBannerTaglineModeMock.mockReturnValue("default");

    const line = formatCliBannerLine("2026.3.7", {
      commit: "abc1234",
      env: { LANG: "en_US.UTF-8" },
      isTty: true,
      platform: "darwin",
      richTty: false,
    });

    expect(line).toBe("🦞 OpenClaw 2026.3.7 (abc1234) — All your chats, one OpenClaw.");
  });

  it("prefers explicit tagline mode over config", () => {
    readCliBannerTaglineModeMock.mockReturnValue("off");

    const line = formatCliBannerLine("2026.3.7", {
      commit: "abc1234",
      env: { LANG: "en_US.UTF-8" },
      isTty: true,
      platform: "darwin",
      richTty: false,
      mode: "default",
    });

    expect(line).toBe("🦞 OpenClaw 2026.3.7 (abc1234) — All your chats, one OpenClaw.");
  });

  it("drops decorative emoji for generic Linux terminals", () => {
    readCliBannerTaglineModeMock.mockReturnValue("off");

    const line = formatCliBannerLine("2026.3.7", {
      commit: "abc1234",
      env: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
      isTty: true,
      platform: "linux",
      richTty: false,
    });

    expect(line).toBe("OpenClaw 2026.3.7 (abc1234)");
  });
});
