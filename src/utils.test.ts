import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureDir,
  resolveConfigDir,
  resolveHomeDir,
  resolveUserPath,
  shortenHomeInString,
  shortenHomePath,
  sleep,
} from "./utils.js";

async function withTempDir<T>(
  prefix: string,
  run: (dir: string) => T | Promise<T>,
): Promise<Awaited<T>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("ensureDir", () => {
  it("creates nested directory", async () => {
    await withTempDir("openclaw-test-", async (tmp) => {
      const target = path.join(tmp, "nested", "dir");
      await ensureDir(target);
      expect(fs.existsSync(target)).toBe(true);
    });
  });
});

describe("sleep", () => {
  it("resolves after delay using fake timers", async () => {
    vi.useFakeTimers();
    const promise = sleep(1000);
    vi.advanceTimersByTime(1000);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

describe("resolveConfigDir", () => {
  it("prefers ~/.openclaw when legacy dir is missing", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-config-dir-"));
    try {
      const newDir = path.join(root, ".openclaw");
      await fs.promises.mkdir(newDir, { recursive: true });
      const resolved = resolveConfigDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(newDir);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("expands OPENCLAW_STATE_DIR using the provided env", () => {
    const env = {
      HOME: "/tmp/openclaw-home",
      OPENCLAW_STATE_DIR: "~/state",
    } as NodeJS.ProcessEnv;

    expect(resolveConfigDir(env)).toBe(path.resolve("/tmp/openclaw-home", "state"));
  });
});

describe("resolveHomeDir", () => {
  it("prefers OPENCLAW_HOME over HOME", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    expect(resolveHomeDir()).toBe(path.resolve("/srv/openclaw-home"));

    vi.unstubAllEnvs();
  });
});

describe("shortenHomePath", () => {
  it("uses $OPENCLAW_HOME prefix when OPENCLAW_HOME is set", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    expect(shortenHomePath(`${path.resolve("/srv/openclaw-home")}/.openclaw/openclaw.json`)).toBe(
      "$OPENCLAW_HOME/.openclaw/openclaw.json",
    );

    vi.unstubAllEnvs();
  });
});

describe("shortenHomeInString", () => {
  it("uses $OPENCLAW_HOME replacement when OPENCLAW_HOME is set", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    expect(
      shortenHomeInString(`config: ${path.resolve("/srv/openclaw-home")}/.openclaw/openclaw.json`),
    ).toBe("config: $OPENCLAW_HOME/.openclaw/openclaw.json");

    vi.unstubAllEnvs();
  });
});

describe("resolveUserPath", () => {
  it("expands ~ to home dir", () => {
    expect(resolveUserPath("~", {}, () => "/Users/thoffman")).toBe(path.resolve("/Users/thoffman"));
  });

  it("expands ~/ to home dir", () => {
    expect(resolveUserPath("~/openclaw", {}, () => "/Users/thoffman")).toBe(
      path.resolve("/Users/thoffman", "openclaw"),
    );
  });

  it("resolves relative paths", () => {
    expect(resolveUserPath("tmp/dir")).toBe(path.resolve("tmp/dir"));
  });

  it("prefers OPENCLAW_HOME for tilde expansion", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    expect(resolveUserPath("~/openclaw")).toBe(path.resolve("/srv/openclaw-home", "openclaw"));

    vi.unstubAllEnvs();
  });

  it("uses the provided env for tilde expansion", () => {
    const env = {
      HOME: "/tmp/openclaw-home",
      OPENCLAW_HOME: "/srv/openclaw-home",
    } as NodeJS.ProcessEnv;

    expect(resolveUserPath("~/openclaw", env)).toBe(path.resolve("/srv/openclaw-home", "openclaw"));
  });

  it("keeps blank paths blank", () => {
    expect(resolveUserPath("")).toBe("");
    expect(resolveUserPath("   ")).toBe("");
  });

  it("returns empty string for undefined/null input", () => {
    expect(resolveUserPath(undefined as unknown as string)).toBe("");
    expect(resolveUserPath(null as unknown as string)).toBe("");
  });
});

import { normalizeE164, sliceUtf16Safe, truncateUtf16Safe } from "./utils.js";

describe("normalizeE164", () => {
  it("keeps valid E.164 numbers unchanged", () => {
    expect(normalizeE164("+1234567890")).toBe("+1234567890");
  });

  it("adds leading + to plain digit numbers", () => {
    expect(normalizeE164("1234567890")).toBe("+1234567890");
  });

  it("strips channel prefixes like whatsapp:", () => {
    expect(normalizeE164("whatsapp:+1234567890")).toBe("+1234567890");
    expect(normalizeE164("signal:1234567890")).toBe("+1234567890");
  });

  it("removes spaces, dashes, and other non-digit characters", () => {
    expect(normalizeE164("+1 234-567-890")).toBe("+1234567890");
    expect(normalizeE164("(123) 456-7890")).toBe("+1234567890");
  });
});

describe("sliceUtf16Safe", () => {
  const emojiStr = "a🦞b🦀c";

  it("handles basic ASCII slicing", () => {
    expect(sliceUtf16Safe("hello", 1, 4)).toBe("ell");
  });

  it("handles negative indices correctly", () => {
    expect(sliceUtf16Safe("hello", -2)).toBe("lo");
    expect(sliceUtf16Safe("hello", 1, -1)).toBe("ell");
  });

  it("safely avoids splitting surrogate pairs at the start", () => {
    // "a🦞b🦀c" indices: 0:a, 1:high(🦞), 2:low(🦞), 3:b, 4:high(🦀), 5:low(🦀), 6:c
    // If we start at index 2 (low surrogate of lobster), it should shift to start at index 3 (b)
    expect(sliceUtf16Safe(emojiStr, 2)).toBe("b🦀c");
  });

  it("safely avoids splitting surrogate pairs at the end", () => {
    // If we end at index 5 (low surrogate of crab), it should shift to end at index 4 (before high surrogate of crab)
    expect(sliceUtf16Safe(emojiStr, 0, 5)).toBe("a🦞b");
  });

  it("handles out of bounds indices gracefully", () => {
    expect(sliceUtf16Safe("hello", -10)).toBe("hello");
    expect(sliceUtf16Safe("hello", 0, 10)).toBe("hello");
  });

  it("handles swapped start/end indices gracefully", () => {
    expect(sliceUtf16Safe("hello", 4, 1)).toBe("ell");
  });
});

describe("truncateUtf16Safe", () => {
  const emojiStr = "a🦞b🦀c";

  it("returns original string if shorter than max length", () => {
    expect(truncateUtf16Safe("hello", 10)).toBe("hello");
  });

  it("returns original string if exactly max length", () => {
    expect(truncateUtf16Safe("hello", 5)).toBe("hello");
  });

  it("truncates ASCII strings to exact length", () => {
    expect(truncateUtf16Safe("hello", 4)).toBe("hell");
  });

  it("safely truncates avoiding splitting surrogate pairs at boundary", () => {
    // "a🦞b🦀c" indices: 0:a, 1:high(🦞), 2:low(🦞), 3:b, 4:high(🦀), 5:low(🦀), 6:c
    // Max length 2 ends on low surrogate of lobster, should safely truncate to 1 (before lobster)
    expect(truncateUtf16Safe(emojiStr, 2)).toBe("a");
    // Max length 5 ends on low surrogate of crab, should safely truncate to 4 (before crab)
    expect(truncateUtf16Safe(emojiStr, 5)).toBe("a🦞b");
  });
});
