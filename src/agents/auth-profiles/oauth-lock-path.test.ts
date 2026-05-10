import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { resolveOAuthRefreshLockPath } from "./paths.js";

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected missing path: ${targetPath}`);
}

describe("resolveOAuthRefreshLockPath", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-lock-path-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("keeps lock paths inside the oauth-refresh directory for dot-segment ids", () => {
    const refreshLockDir = path.join(stateDir, "locks", "oauth-refresh");
    const dotSegmentPath = resolveOAuthRefreshLockPath("openai-codex", "..");
    const currentDirPath = resolveOAuthRefreshLockPath("openai-codex", ".");

    expect(path.dirname(dotSegmentPath)).toBe(refreshLockDir);
    expect(path.dirname(currentDirPath)).toBe(refreshLockDir);
    expect(path.basename(dotSegmentPath)).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(path.basename(currentDirPath)).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(path.basename(dotSegmentPath)).not.toBe(path.basename(currentDirPath));
  });

  it("hashes profile ids so distinct values stay distinct", () => {
    expect(resolveOAuthRefreshLockPath("openai-codex", "openai-codex:work/test")).not.toBe(
      resolveOAuthRefreshLockPath("openai-codex", "openai-codex_work:test"),
    );
    // Unicode normalization / collation corner cases must still hash distinctly.
    expect(resolveOAuthRefreshLockPath("openai-codex", "«c")).not.toBe(
      resolveOAuthRefreshLockPath("openai-codex", "઼"),
    );
  });

  it("hashes distinct providers to distinct paths for the same profileId", () => {
    // The new (provider, profileId) keying is the whole point of P2 from
    // review: a shared profileId across providers must not collide.
    expect(resolveOAuthRefreshLockPath("openai-codex", "shared:default")).not.toBe(
      resolveOAuthRefreshLockPath("anthropic", "shared:default"),
    );
  });

  it("is immune to simple concat collisions at the provider/profile boundary", () => {
    // With a plain `${provider}:${profileId}` hash input, the pair
    // ("a", "b:c") would collide with ("a:b", "c"). The NUL separator
    // in the hash input rules that out.
    expect(resolveOAuthRefreshLockPath("a", "b:c")).not.toBe(
      resolveOAuthRefreshLockPath("a:b", "c"),
    );
  });

  it("keeps lock filenames short for long profile ids", () => {
    const longProfileId = `openai-codex:${"x".repeat(512)}`;
    const basename = path.basename(resolveOAuthRefreshLockPath("openai-codex", longProfileId));

    expect(basename).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(Buffer.byteLength(basename, "utf8")).toBeLessThan(255);
  });

  it("is deterministic: same (provider, profileId) produces the same path", () => {
    const first = resolveOAuthRefreshLockPath("openai-codex", "openai-codex:default");
    const second = resolveOAuthRefreshLockPath("openai-codex", "openai-codex:default");
    expect(first).toBe(second);
  });

  it("returns a valid path on a clean install where the locks/ directory does not yet exist", async () => {
    // Defensive check: even on a fresh install with no lock hierarchy
    // populated, the function must return a safe path. withFileLock
    // internally creates missing parent dirs, but this test pins the
    // expectation so a future change to remove that guarantee would
    // fail loudly.
    const locksDir = path.join(stateDir, "locks", "oauth-refresh");
    // Sanity precondition: parent dir must not exist yet.
    await expectPathMissing(locksDir);

    const resolved = resolveOAuthRefreshLockPath("openai-codex", "openai-codex:default");
    expect(path.dirname(resolved)).toBe(locksDir);
    expect(path.basename(resolved)).toMatch(/^sha256-[0-9a-f]{64}$/);
    // Function itself must not create the directory (path resolver only).
    await expectPathMissing(locksDir);
  });

  it("never embeds path separators or .. in the basename", () => {
    const hazards = [
      ["openai-codex", "../etc/passwd"],
      ["openai-codex", "../../../../secrets"],
      ["openai-codex", "openai\\codex"],
      ["openai-codex", "openai/codex/default"],
      ["openai-codex", "profile\x00with-null"],
      ["openai-codex", "profile\nwith-newline"],
      ["openai-codex", "profile with spaces"],
      ["../../etc", "passwd"],
      ["provider\x00with-null", "default"],
    ] as const;
    for (const [provider, id] of hazards) {
      const basename = path.basename(resolveOAuthRefreshLockPath(provider, id));
      expect(basename).toMatch(/^sha256-[0-9a-f]{64}$/);
      expect(basename).not.toContain("/");
      expect(basename).not.toContain("\\");
      expect(basename).not.toContain("..");
      expect(basename).not.toContain("\x00");
      expect(basename).not.toContain("\n");
    }
  });
});

describe("resolveOAuthRefreshLockPath fuzz", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-lock-path-fuzz-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  function makeSeededRandom(seed: number): () => number {
    // Mulberry32 — small, stable, seedable PRNG so the fuzz run is reproducible
    // even if the suite later becomes picky about test ordering.
    let t = seed >>> 0;
    return () => {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = t;
      r = Math.imul(r ^ (r >>> 15), r | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomProfileId(rng: () => number, maxLen: number): string {
    const len = Math.floor(rng() * maxLen);
    const chars: string[] = [];
    for (let i = 0; i < len; i += 1) {
      // Cover BMP + surrogate-pair range + control chars + ASCII + path hazards.
      const category = Math.floor(rng() * 5);
      const code =
        category === 0
          ? Math.floor(rng() * 128) // ASCII
          : category === 1
            ? Math.floor(rng() * 32) // control chars (including \0, \n, \r, etc.)
            : category === 2
              ? 0x10000 + Math.floor(rng() * 0xeffff) // supplementary planes
              : category === 3
                ? Math.floor(rng() * 0xd800) // BMP non-surrogate
                : 0x0f00 + Math.floor(rng() * 0x0100); // misc unicode
      chars.push(String.fromCodePoint(code));
    }
    return chars.join("");
  }

  it("always produces a basename that matches sha256-<hex64> regardless of input", () => {
    const rng = makeSeededRandom(0x2026_0417);
    for (let i = 0; i < 500; i += 1) {
      const provider = randomProfileId(rng, 64) || "openai-codex";
      const id = randomProfileId(rng, 4096);
      const basename = path.basename(resolveOAuthRefreshLockPath(provider, id));
      expect(basename).toMatch(/^sha256-[0-9a-f]{64}$/);
      expect(Buffer.byteLength(basename, "utf8")).toBeLessThan(255);
      // sha256-<64 hex> = 71 chars, no path hazards. Explicit substring
      // checks (no control-char regex) to keep lint happy.
      expect(basename).not.toContain("\\");
      expect(basename).not.toContain("/");
      expect(basename).not.toContain("\u0000");
      expect(basename).not.toContain("\n");
      expect(basename).not.toContain("\r");
      expect(basename).not.toContain("..");
    }
  });

  it("always resolves to a path inside <stateDir>/locks/oauth-refresh", () => {
    const rng = makeSeededRandom(0xdecafbad);
    const expectedDir = path.join(stateDir, "locks", "oauth-refresh");
    for (let i = 0; i < 200; i += 1) {
      const provider = randomProfileId(rng, 32) || "openai-codex";
      const id = randomProfileId(rng, 1024);
      const resolved = resolveOAuthRefreshLockPath(provider, id);
      expect(path.dirname(resolved)).toBe(expectedDir);
      // Normalized path must still live under the expected directory — defense
      // against any future change that lets a profile id escape the scope.
      expect(path.normalize(resolved).startsWith(expectedDir + path.sep)).toBe(true);
    }
  });

  it("distinct (provider, profileId) inputs produce distinct outputs over a large random sample", () => {
    const rng = makeSeededRandom(0x1234_5678);
    const seen = new Map<string, string>();
    let collisions = 0;
    for (let i = 0; i < 2000; i += 1) {
      const provider = randomProfileId(rng, 32) || "p";
      const id = randomProfileId(rng, 256);
      const composite = `${provider}\u0000${id}`;
      const resolved = resolveOAuthRefreshLockPath(provider, id);
      const existing = seen.get(resolved);
      if (existing !== undefined && existing !== composite) {
        collisions += 1;
      }
      seen.set(resolved, composite);
    }
    expect(collisions).toBe(0);
  });

  it("holding provider fixed, distinct profileIds never collide", () => {
    const rng = makeSeededRandom(0xf00dbabe);
    const seen = new Map<string, string>();
    let collisions = 0;
    for (let i = 0; i < 1000; i += 1) {
      const id = randomProfileId(rng, 128) || `id-${i}`;
      const resolved = resolveOAuthRefreshLockPath("openai-codex", id);
      const existing = seen.get(resolved);
      if (existing !== undefined && existing !== id) {
        collisions += 1;
      }
      seen.set(resolved, id);
    }
    expect(collisions).toBe(0);
  });

  it("holding profileId fixed, distinct providers never collide", () => {
    const rng = makeSeededRandom(0xbad1d00d);
    const seen = new Map<string, string>();
    let collisions = 0;
    for (let i = 0; i < 500; i += 1) {
      const provider = randomProfileId(rng, 64) || `provider-${i}`;
      const resolved = resolveOAuthRefreshLockPath(provider, "shared-profile-id");
      const existing = seen.get(resolved);
      if (existing !== undefined && existing !== provider) {
        collisions += 1;
      }
      seen.set(resolved, provider);
    }
    expect(collisions).toBe(0);
  });
});
