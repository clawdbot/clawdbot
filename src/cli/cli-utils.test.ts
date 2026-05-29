import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerDnsCli } from "./dns-cli.js";
import { parseByteSize } from "./parse-bytes.js";
import { parseDurationMs } from "./parse-duration.js";
import {
  shouldSkipRespawnForArgv,
  shouldSkipStartupEnvironmentRespawnForArgv,
} from "./respawn-policy.js";
import { waitForever } from "./wait.js";

describe("waitForever", () => {
  it("keeps the event loop alive (ref'd interval) and returns a pending promise", () => {
    const unref = vi.fn();
    const interval = { unref } as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue(interval);
    try {
      const promise = waitForever();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      const [callback, delay] = setIntervalSpy.mock.calls[0] ?? [];
      expect(typeof callback).toBe("function");
      expect(delay).toBe(1_000_000);
      // Regression guard for the previous `.unref()` bug: an unref'd interval
      // does NOT keep the event loop alive, so `await waitForever()` would
      // exit immediately with code 13 ("unsettled top-level await"). The
      // function must NOT unref the interval.
      expect(unref).not.toHaveBeenCalled();
      expect(promise).toBeInstanceOf(Promise);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});

describe("shouldSkipRespawnForArgv", () => {
  it.each([
    { argv: ["node", "openclaw", "--help"] },
    { argv: ["node", "openclaw", "-V"] },
    { argv: ["node", "openclaw", "tui"] },
    { argv: ["node", "openclaw", "terminal"] },
    { argv: ["node", "openclaw", "chat"] },
    { argv: ["node", "openclaw", "gateway"] },
    { argv: ["node", "openclaw", "gateway", "--port", "14720", "--bind", "loopback"] },
    { argv: ["node", "openclaw", "gateway", "run", "--port=14720", "--bind", "loopback"] },
    {
      argv: ["node", "openclaw", "--profile", "server", "gateway", "run", "--allow-unconfigured"],
    },
  ] as const)("skips respawn for argv %j", ({ argv }) => {
    expect(shouldSkipRespawnForArgv([...argv]), argv.join(" ")).toBe(true);
  });

  it.each([
    { argv: ["node", "openclaw", "status"] },
    { argv: ["node", "openclaw", "gateway", "status"] },
    { argv: ["node", "openclaw", "gateway", "call", "health"] },
  ] as const)("keeps respawn path for argv %j", ({ argv }) => {
    expect(shouldSkipRespawnForArgv([...argv]), argv.join(" ")).toBe(false);
  });
});

describe("shouldSkipStartupEnvironmentRespawnForArgv", () => {
  it.each([
    { argv: ["node", "openclaw", "--help"] },
    { argv: ["node", "openclaw", "gateway"] },
    { argv: ["node", "openclaw", "gateway", "run", "--port=14720"] },
  ] as const)("skips startup env respawn for argv %j", ({ argv }) => {
    expect(shouldSkipStartupEnvironmentRespawnForArgv([...argv]), argv.join(" ")).toBe(true);
  });

  it.each([
    { argv: ["node", "openclaw", "tui"] },
    { argv: ["node", "openclaw", "terminal"] },
    { argv: ["node", "openclaw", "chat"] },
    { argv: ["node", "openclaw", "status"] },
  ] as const)("allows startup env respawn for argv %j", ({ argv }) => {
    expect(shouldSkipStartupEnvironmentRespawnForArgv([...argv]), argv.join(" ")).toBe(false);
  });
});

describe("dns cli", () => {
  it("prints setup info (no apply)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const program = new Command();
      registerDnsCli(program);
      await program.parseAsync(["dns", "setup", "--domain", "openclaw.internal"], { from: "user" });
      const output = log.mock.calls.map((call) => call.join(" ")).join("\\n");
      expect(output).toContain("DNS setup");
      expect(output).toContain("openclaw.internal");
    } finally {
      log.mockRestore();
    }
  });

  it.each(["foo/bar", "../../x", "evil\nrecords"])(
    "rejects invalid --domain %j with explicit DNS-name diagnostic",
    async (domain) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const program = new Command();
        registerDnsCli(program);
        await expect(
          program.parseAsync(["dns", "setup", "--domain", domain], { from: "user" }),
        ).rejects.toThrow("wide-area discovery domain must be a valid DNS name");
        const output = log.mock.calls.map((call) => call.join(" ")).join("\\n");
        expect(output).not.toContain("No wide-area domain configured");
        expect(output).not.toContain("DNS setup");
      } finally {
        log.mockRestore();
      }
    },
  );
});

describe("parseByteSize", () => {
  it.each([
    ["parses 10kb", "10kb", 10 * 1024],
    ["parses 1mb", "1mb", 1024 * 1024],
    ["parses 2gb", "2gb", 2 * 1024 * 1024 * 1024],
    ["parses shorthand 5k", "5k", 5 * 1024],
    ["parses shorthand 1m", "1m", 1024 * 1024],
  ] as const)("%s", (_name, input, expected) => {
    expect(parseByteSize(input)).toBe(expected);
  });

  it("uses default unit when omitted", () => {
    expect(parseByteSize("123")).toBe(123);
  });

  it.each(["", "nope", "-5kb"] as const)("rejects invalid value %j", (input) => {
    expect(() => parseByteSize(input)).toThrow(/Invalid byte size/);
  });
});

describe("parseDurationMs", () => {
  it.each([
    ["parses bare ms", "10000", 10_000],
    ["parses seconds suffix", "10s", 10_000],
    ["parses minutes suffix", "1m", 60_000],
    ["parses hours suffix", "2h", 7_200_000],
    ["parses days suffix", "2d", 172_800_000],
    ["supports decimals", "0.5s", 500],
    ["parses composite hours+minutes", "1h30m", 5_400_000],
    ["parses composite with milliseconds", "2m500ms", 120_500],
  ] as const)("%s", (_name, input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it("rejects invalid composite strings", () => {
    expect(() => parseDurationMs("1h30")).toThrow(/Invalid duration/);
    expect(() => parseDurationMs("1h-30m")).toThrow(/Invalid duration/);
  });

  it("rejects unsafe millisecond results", () => {
    expect(() => parseDurationMs("9007199254740993ms")).toThrow(/Invalid duration/);
    expect(() => parseDurationMs("9007199254740990ms10ms")).toThrow(/Invalid duration/);
  });
});
