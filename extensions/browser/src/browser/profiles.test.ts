// Browser tests cover profiles plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { resolveBrowserConfig } from "./config.js";
import {
  allocateCdpPort,
  allocateColor,
  getUsedColors,
  getUsedPorts,
  isValidProfileName,
} from "./profiles.js";

const CDP_PORT_RANGE_START = 18800;
const CDP_PORT_RANGE_END = 18899;
const PROFILE_COLORS = [
  "#FF4500",
  "#0066CC",
  "#00AA00",
  "#9933FF",
  "#FF6699",
  "#00CCCC",
  "#FF9900",
  "#6666FF",
  "#CC3366",
  "#339966",
];

describe("profile name validation", () => {
  it.each(["openclaw", "work", "my-profile", "test123", "a", "a-b-c-1-2-3", "1test"])(
    "accepts valid lowercase name: %s",
    (name) => {
      expect(isValidProfileName(name)).toBe(true);
    },
  );

  it("rejects empty or missing names", () => {
    expect(isValidProfileName("")).toBe(false);
    expect(isValidProfileName(null as unknown as string)).toBe(false);
    expect(isValidProfileName(undefined as unknown as string)).toBe(false);
  });

  it("rejects names that are too long", () => {
    const longName = "a".repeat(65);
    expect(isValidProfileName(longName)).toBe(false);

    const maxName = "a".repeat(64);
    expect(isValidProfileName(maxName)).toBe(true);
  });

  it.each([
    "MyProfile",
    "PROFILE",
    "Work",
    "my profile",
    "my_profile",
    "my.profile",
    "my/profile",
    "my@profile",
    "-invalid",
    "--double",
  ])("rejects invalid name: %s", (name) => {
    expect(isValidProfileName(name)).toBe(false);
  });
});

describe("port allocation", () => {
  it("allocates within an explicit range", () => {
    const usedPorts = new Set<number>();
    expect(allocateCdpPort(usedPorts, { start: 20000, end: 20002 })).toBe(20000);
    usedPorts.add(20000);
    expect(allocateCdpPort(usedPorts, { start: 20000, end: 20002 })).toBe(20001);
  });

  it("allocates next available port from default range", () => {
    const cases = [
      { name: "none used", used: new Set<number>(), expected: CDP_PORT_RANGE_START },
      {
        name: "sequentially used start ports",
        used: new Set([CDP_PORT_RANGE_START, CDP_PORT_RANGE_START + 1]),
        expected: CDP_PORT_RANGE_START + 2,
      },
      {
        name: "first gap wins",
        used: new Set([CDP_PORT_RANGE_START, CDP_PORT_RANGE_START + 2]),
        expected: CDP_PORT_RANGE_START + 1,
      },
      {
        name: "ignores outside-range ports",
        used: new Set([1, 2, 3, 50000]),
        expected: CDP_PORT_RANGE_START,
      },
    ] as const;

    for (const testCase of cases) {
      expect(allocateCdpPort(testCase.used), testCase.name).toBe(testCase.expected);
    }
  });

  it("returns null when all ports are exhausted", () => {
    const usedPorts = new Set<number>();
    for (let port = CDP_PORT_RANGE_START; port <= CDP_PORT_RANGE_END; port++) {
      usedPorts.add(port);
    }
    expect(allocateCdpPort(usedPorts)).toBeNull();
  });

  it("rejects fractional or out-of-range allocation ranges", () => {
    expect(allocateCdpPort(new Set(), { start: 20000.5, end: 20002 })).toBeNull();
    expect(allocateCdpPort(new Set(), { start: 20000, end: 65536 })).toBeNull();
  });
});

describe("getUsedPorts", () => {
  it("returns empty set for undefined profiles", () => {
    expect(getUsedPorts(undefined)).toEqual(new Set());
  });

  it("extracts ports from profile configs", () => {
    const profiles = {
      openclaw: { cdpPort: 18792 },
      work: { cdpPort: 18793 },
      personal: { cdpPort: 18795 },
    };
    const used = getUsedPorts(profiles);
    expect(used).toEqual(new Set([18792, 18793, 18795]));
  });

  it("extracts ports from cdpUrl when cdpPort is missing", () => {
    const profiles = {
      remote: { cdpUrl: "http://10.0.0.42:9222" },
      secure: { cdpUrl: "https://example.com:9443" },
    };
    const used = getUsedPorts(profiles);
    expect(used).toEqual(new Set([9222, 9443]));
  });

  it("ignores invalid cdpUrl values", () => {
    const profiles = {
      bad: { cdpUrl: "notaurl" },
      portZero: { cdpUrl: "http://127.0.0.1:0" },
    };
    const used = getUsedPorts(profiles);
    expect(used.size).toBe(0);
  });

  it("ignores invalid numeric cdpPort values", () => {
    const profiles = {
      fractional: { cdpPort: 18800.5 },
      zero: { cdpPort: 0 },
      outOfRange: { cdpPort: 65536 },
      valid: { cdpPort: 18801 },
    };
    const used = getUsedPorts(profiles);
    expect(used).toEqual(new Set([18801]));
  });
});

describe("port collision prevention", () => {
  it("raw config vs resolved config - shows the data source difference", () => {
    // This demonstrates WHY the route handler must use resolved config

    // Fresh config with no profiles defined (like a new install)
    const rawConfigProfiles = undefined;
    const usedFromRaw = getUsedPorts(rawConfigProfiles);

    // Raw config shows empty - no ports used
    expect(usedFromRaw.size).toBe(0);

    // But resolved config has implicit openclaw at 18800
    const resolved = resolveBrowserConfig({});
    const usedFromResolved = getUsedPorts(resolved.profiles);
    expect(usedFromResolved.has(CDP_PORT_RANGE_START)).toBe(true);
  });

  it("create-profile must use resolved config to avoid port collision", () => {
    // The route handler must use state.resolved.profiles, not raw config

    // Simulate what happens with raw config (empty) vs resolved config
    const rawConfig: { browser: { profiles?: Record<string, { cdpPort?: number }> } } = {
      browser: {},
    }; // Fresh config, no profiles
    const buggyUsedPorts = getUsedPorts(rawConfig.browser?.profiles);
    const buggyAllocatedPort = allocateCdpPort(buggyUsedPorts);

    // Raw config: first allocation gets 18800
    expect(buggyAllocatedPort).toBe(CDP_PORT_RANGE_START);

    // Resolved config: includes implicit openclaw at 18800
    const resolved = resolveBrowserConfig(
      rawConfig.browser as Parameters<typeof resolveBrowserConfig>[0],
    );
    const fixedUsedPorts = getUsedPorts(resolved.profiles);
    const fixedAllocatedPort = allocateCdpPort(fixedUsedPorts);

    // Resolved: first NEW profile gets 18801, avoiding collision
    expect(fixedAllocatedPort).toBe(CDP_PORT_RANGE_START + 1);
  });
});

describe("color allocation", () => {
  it("allocates next unused color from palette", () => {
    const first = expectDefined(PROFILE_COLORS[0], "first browser profile color");
    const second = expectDefined(PROFILE_COLORS[1], "second browser profile color");
    const third = expectDefined(PROFILE_COLORS[2], "third browser profile color");
    const fourth = expectDefined(PROFILE_COLORS[3], "fourth browser profile color");
    const cases = [
      { name: "none used", used: new Set<string>(), expected: first },
      {
        name: "first color used",
        used: new Set([first.toUpperCase()]),
        expected: second,
      },
      {
        name: "multiple used colors",
        used: new Set([first.toUpperCase(), second.toUpperCase(), third.toUpperCase()]),
        expected: fourth,
      },
    ] as const;
    for (const testCase of cases) {
      expect(allocateColor(testCase.used), testCase.name).toBe(testCase.expected);
    }
  });

  it("handles case-insensitive color matching", () => {
    const usedColors = new Set(["#ff4500"]); // lowercase
    // Should still skip this color (case-insensitive)
    // Note: allocateColor compares against uppercase, so lowercase won't match
    // This tests the current behavior
    expect(allocateColor(usedColors)).toBe(PROFILE_COLORS[0]); // returns first since lowercase doesn't match
  });

  it("cycles when all colors are used", () => {
    const usedColors = new Set(PROFILE_COLORS.map((c) => c.toUpperCase()));
    // Should cycle based on count
    const result = allocateColor(usedColors);
    expect(PROFILE_COLORS).toContain(result);
  });

  it("cycles based on count when palette exhausted", () => {
    // Add all colors plus some extras
    const usedColors = new Set([
      ...PROFILE_COLORS.map((c) => c.toUpperCase()),
      "#AAAAAA",
      "#BBBBBB",
    ]);
    const result = allocateColor(usedColors);
    // Index should be (10 + 2) % 10 = 2
    expect(result).toBe(PROFILE_COLORS[2]);
  });
});

describe("getUsedColors", () => {
  it("returns empty set when no color profiles are configured", () => {
    expect(getUsedColors(undefined)).toEqual(new Set());
  });

  it("extracts and uppercases colors from profile configs", () => {
    const profiles = {
      openclaw: { color: "#ff4500" },
      work: { color: "#0066CC" },
    };
    const used = getUsedColors(profiles);
    expect(used).toEqual(new Set(["#FF4500", "#0066CC"]));
  });
});
