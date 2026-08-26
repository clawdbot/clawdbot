// Banner tests cover CLI banner rendering and suppression behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCliBannerLine } from "./banner.js";

const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

vi.mock("./banner-config-lite.js", () => ({
  parseTaglineMode: (value: unknown) =>
    value === "random" || value === "default" || value === "off" ? value : undefined,
}));

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
  it("hides tagline text when explicitly disabled", () => {
    const line = formatCliBannerLine("2026.3.7", {
      commit: "abc1234",
      env: { LANG: "en_US.UTF-8" },
      isTty: true,
      platform: "darwin",
      richTty: false,
      mode: "off",
    });

    expect(line).toBe("🦞 OpenClaw 2026.3.7 (abc1234)");
  });

  it("uses the default tagline when explicitly requested", () => {
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
    const line = formatCliBannerLine("2026.3.7", {
      commit: "abc1234",
      env: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
      isTty: true,
      platform: "linux",
      richTty: false,
      mode: "off",
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

  it("adds the ASCII lobster on lobster days for rich random-mode terminals", async () => {
    const { emitCliBanner } = await importFreshBannerModule();
    setStdoutIsTty(true);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    emitCliBanner("2026.3.7", {
      argv: ["node", "openclaw"],
      commit: "abc1234",
      env: { LANG: "en_US.UTF-8" },
      isTty: true,
      mode: "random",
      now: () => new Date(2026, 1, 26),
      platform: "darwin",
      richTty: true,
    });

    const written = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(written).toContain("( o.o )");
  });

  it.each([
    { label: "plain terminals", mode: "random" as const, richTty: false },
    { label: "pinned tagline modes", mode: "off" as const, richTty: true },
  ])("keeps lobster day out of $label", async ({ mode, richTty }) => {
    const { emitCliBanner } = await importFreshBannerModule();
    setStdoutIsTty(true);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    emitCliBanner("2026.3.7", {
      argv: ["node", "openclaw"],
      commit: "abc1234",
      env: { LANG: "en_US.UTF-8" },
      isTty: true,
      mode,
      now: () => new Date(2026, 1, 26),
      platform: "darwin",
      richTty,
    });

    const written = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(written).not.toContain("( o.o )");
  });

  it("emits only once per module instance", async () => {
    const { emitCliBanner, hasEmittedCliBanner } = await importFreshBannerModule();
    setStdoutIsTty(true);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const options = {
      argv: ["node", "openclaw"],
      commit: "abc1234",
      env: { LANG: "en_US.UTF-8" },
      isTty: true,
      mode: "off" as const,
      platform: "darwin" as const,
      richTty: false,
    };

    emitCliBanner("2026.3.7", options);
    emitCliBanner("2026.3.7", options);

    expect(hasEmittedCliBanner()).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});
