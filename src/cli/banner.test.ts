// Banner tests cover CLI banner rendering and suppression behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliBannerLine } from "./banner.js";

const readCliBannerTaglineModeMock = vi.hoisted(() => vi.fn());
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

vi.mock("./banner-config-lite.js", () => ({
  parseTaglineMode: (value: unknown) =>
    value === "random" || value === "default" || value === "off" ? value : undefined,
  readCliBannerTaglineMode: readCliBannerTaglineModeMock,
}));

beforeEach(() => {
  readCliBannerTaglineModeMock.mockReset();
  readCliBannerTaglineModeMock.mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (stdoutIsTtyDescriptor) {
    Object.defineProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
  } else {
    delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});

async function importFreshBannerModule() {
  vi.resetModules();
  return await import("./banner.js");
}

function setStdoutIsTty(value: boolean) {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value,
  });
}

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

describe("emitCliBanner", () => {
  it("uses injected non-TTY state before writing to stdout", async () => {
    const { emitCliBanner, hasEmittedCliBanner } = await importFreshBannerModule();
    setStdoutIsTty(true);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    emitCliBanner("2026.3.7", {
      argv: ["node", "openclaw"],
      commit: "abc1234",
      isTty: false,
      mode: "off",
      richTty: false,
    });

    expect(writeSpy).not.toHaveBeenCalled();
    expect(hasEmittedCliBanner()).toBe(false);
  });

  it("allows injected TTY state to emit when stdout lacks isTTY", async () => {
    const { emitCliBanner, hasEmittedCliBanner } = await importFreshBannerModule();
    setStdoutIsTty(false);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    emitCliBanner("2026.3.7", {
      argv: ["node", "openclaw"],
      commit: "abc1234",
      env: { LANG: "en_US.UTF-8" },
      isTty: true,
      mode: "off",
      platform: "darwin",
      richTty: false,
    });

    expect(writeSpy).toHaveBeenCalledWith("\n🦞 OpenClaw 2026.3.7 (abc1234)\n\n");
    expect(hasEmittedCliBanner()).toBe(true);
  });
});
