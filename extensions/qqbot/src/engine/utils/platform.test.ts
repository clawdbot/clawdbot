import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getHomeDir,
  getQQBotDataPath,
  getQQBotMediaPath,
  resolveQQBotLocalMediaPath,
  resolveQQBotPayloadLocalFilePath,
} from "./platform.js";

describe("qqbot local media path remapping", () => {
  const createdPaths: string[] = [];

  function createOpenClawTestRoot() {
    const actualHome = getHomeDir();
    const openclawDir = path.join(actualHome, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    const testRoot = fs.mkdtempSync(path.join(openclawDir, "qqbot-platform-test-"));
    createdPaths.push(testRoot);
    return { actualHome, testRootName: path.basename(testRoot) };
  }

  function createQqbotMediaFile(fileName: string) {
    const { actualHome, testRootName } = createOpenClawTestRoot();
    const mediaFile = path.join(
      actualHome,
      ".openclaw",
      "media",
      "qqbot",
      "downloads",
      testRootName,
      fileName,
    );
    fs.mkdirSync(path.dirname(mediaFile), { recursive: true });
    fs.writeFileSync(mediaFile, "image", "utf8");
    createdPaths.push(path.dirname(mediaFile));
    return { actualHome, testRootName, mediaFile };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const target of createdPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("remaps missing workspace media paths to the real media directory", () => {
    const { actualHome, testRootName, mediaFile } = createQqbotMediaFile("example.png");

    const missingWorkspacePath = path.join(
      actualHome,
      ".openclaw",
      "workspace",
      "qqbot",
      "downloads",
      testRootName,
      "example.png",
    );

    expect(resolveQQBotLocalMediaPath(missingWorkspacePath)).toBe(mediaFile);
  });

  it("leaves existing media paths unchanged", () => {
    const { mediaFile } = createQqbotMediaFile("existing.png");

    expect(resolveQQBotLocalMediaPath(mediaFile)).toBe(mediaFile);
  });

  it("blocks structured payload files outside QQ Bot storage", () => {
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-platform-outside-"));
    createdPaths.push(outsideRoot);

    const outsideFile = path.join(outsideRoot, "secret.txt");
    fs.writeFileSync(outsideFile, "secret", "utf8");

    expect(resolveQQBotPayloadLocalFilePath(outsideFile)).toBeNull();
  });

  it("blocks structured payload paths that escape QQ Bot media via '..'", () => {
    const escapedPath = path.join(
      getHomeDir(),
      ".openclaw",
      "media",
      "qqbot",
      "..",
      "..",
      "qqbot-escape.txt",
    );

    expect(resolveQQBotPayloadLocalFilePath(escapedPath)).toBeNull();
  });

  it("allows structured payload files inside the QQ Bot media directory", () => {
    const { mediaFile } = createQqbotMediaFile("allowed.png");

    expect(resolveQQBotPayloadLocalFilePath(mediaFile)).toBe(fs.realpathSync(mediaFile));
  });

  it("allows structured payload files inside sibling OpenClaw media subdirectories", () => {
    // Core helpers such as `saveMediaBuffer(..., "outbound", ...)` place framework
    // attachments under sibling directories of `media/qqbot/`. The plugin must
    // trust the shared `~/.openclaw/media` root so auto-routed sends can access
    // those files without the path-outside-storage guard firing.
    const actualHome = getHomeDir();
    const outboundDir = path.join(actualHome, ".openclaw", "media", "outbound");
    fs.mkdirSync(outboundDir, { recursive: true });
    const outboundFile = fs.mkdtempSync(path.join(outboundDir, "qqbot-outbound-"));
    const mediaFile = path.join(outboundFile, "tts.mp3");
    fs.writeFileSync(mediaFile, "audio", "utf8");
    createdPaths.push(outboundFile);

    expect(resolveQQBotPayloadLocalFilePath(mediaFile)).toBe(fs.realpathSync(mediaFile));
  });

  it("blocks structured payload files inside the QQ Bot data directory", () => {
    const { actualHome, testRootName } = createOpenClawTestRoot();

    const dataFile = path.join(
      actualHome,
      ".openclaw",
      "qqbot",
      "sessions",
      testRootName,
      "session.json",
    );
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, "{}", "utf8");
    createdPaths.push(path.dirname(dataFile));

    expect(resolveQQBotPayloadLocalFilePath(dataFile)).toBeNull();
  });

  it("allows legacy workspace paths when they remap into QQ Bot media storage", () => {
    const { actualHome, testRootName, mediaFile } = createQqbotMediaFile("legacy.png");

    const missingWorkspacePath = path.join(
      actualHome,
      ".openclaw",
      "workspace",
      "qqbot",
      "downloads",
      testRootName,
      "legacy.png",
    );

    expect(resolveQQBotPayloadLocalFilePath(missingWorkspacePath)).toBe(fs.realpathSync(mediaFile));
  });
});

// Regression coverage for https://github.com/openclaw/openclaw/issues/83562 —
// when HOME and OPENCLAW_HOME diverge (Docker, multi-user hosts), QQ Bot media
// paths must be anchored on OPENCLAW_HOME so files written under
// `$OPENCLAW_HOME/.openclaw/media/qqbot/` are accepted by the outbound
// allowlist.
//
// Tests intentionally do NOT mock `os.homedir()` — the helper reads it via
// `import * as os from "node:os"` which `vi.spyOn` cannot reliably intercept
// across the ESM/CJS interop boundary. Instead each test treats the real OS
// home as the baseline and only varies `process.env.OPENCLAW_HOME`.
describe("qqbot media path resolution honors OPENCLAW_HOME (#83562)", () => {
  const tempPaths: string[] = [];
  const realOsHome = getHomeDir();

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const target of tempPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  function makeFakeOpenclawHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-oc-home-"));
    tempPaths.push(dir);
    return dir;
  }

  function isPathInsideOrEqual(candidate: string, parent: string): boolean {
    const relative = path.relative(parent, candidate);
    return (
      relative === "" ||
      (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
    );
  }

  it("accepts files under $OPENCLAW_HOME/.openclaw/media/qqbot when OPENCLAW_HOME differs from HOME", () => {
    const fakeOpenclawHome = makeFakeOpenclawHome();
    vi.stubEnv("OPENCLAW_HOME", fakeOpenclawHome);

    const mediaFile = path.join(fakeOpenclawHome, ".openclaw", "media", "qqbot", "repro.png");
    // Sanity: the fixture must not be accepted by the previous HOME media root.
    // On Windows, `os.tmpdir()` commonly lives under the user profile, so a raw
    // HOME-prefix assertion would make this test fail for the wrong reason.
    const oldHomeMediaRoot = path.join(realOsHome, ".openclaw", "media", "qqbot");
    expect(isPathInsideOrEqual(mediaFile, oldHomeMediaRoot)).toBe(false);
    fs.mkdirSync(path.dirname(mediaFile), { recursive: true });
    fs.writeFileSync(mediaFile, "image", "utf8");

    expect(getQQBotMediaPath()).toBe(path.join(fakeOpenclawHome, ".openclaw", "media", "qqbot"));
    expect(resolveQQBotPayloadLocalFilePath(mediaFile)).toBe(fs.realpathSync(mediaFile));
  });

  it("expands tilde-prefixed OPENCLAW_HOME against the OS home", () => {
    // Use a unique subdirectory name so we can clean it up safely without
    // touching anything that exists under the real home.
    const sub = `qqbot-tilde-${process.pid}-${Date.now()}`;
    const expectedHome = path.join(realOsHome, sub);
    tempPaths.push(expectedHome);
    vi.stubEnv("OPENCLAW_HOME", `~/${sub}`);

    expect(getQQBotMediaPath()).toBe(path.join(expectedHome, ".openclaw", "media", "qqbot"));

    const mediaFile = path.join(expectedHome, ".openclaw", "media", "qqbot", "tilde.png");
    fs.mkdirSync(path.dirname(mediaFile), { recursive: true });
    fs.writeFileSync(mediaFile, "image", "utf8");

    expect(resolveQQBotPayloadLocalFilePath(mediaFile)).toBe(fs.realpathSync(mediaFile));
  });

  it("falls back to OS home when OPENCLAW_HOME is unset (no regression)", () => {
    vi.stubEnv("OPENCLAW_HOME", "");

    expect(getQQBotMediaPath()).toBe(path.join(realOsHome, ".openclaw", "media", "qqbot"));
  });

  it("treats sentinel strings 'undefined' and 'null' as unset", () => {
    for (const sentinel of ["undefined", "null"]) {
      vi.stubEnv("OPENCLAW_HOME", sentinel);
      expect(getQQBotMediaPath()).toBe(path.join(realOsHome, ".openclaw", "media", "qqbot"));
    }
  });

  it("keeps persisted QQ Bot data anchored on the OS home (compatibility)", () => {
    const fakeOpenclawHome = makeFakeOpenclawHome();
    vi.stubEnv("OPENCLAW_HOME", fakeOpenclawHome);

    // Persisted state (sessions, known users, refs) must NOT migrate when an
    // operator adds OPENCLAW_HOME — otherwise existing deployments would lose
    // their session state. Only the media root follows OPENCLAW_HOME.
    expect(getQQBotDataPath()).toBe(path.join(realOsHome, ".openclaw", "qqbot"));
  });

  it("rejects files that live under HOME tree when OPENCLAW_HOME is the active root", () => {
    const fakeOpenclawHome = makeFakeOpenclawHome();
    vi.stubEnv("OPENCLAW_HOME", fakeOpenclawHome);

    // File under the HOME-side mirror — exactly the path that *worked* on
    // current main and *broke* the OPENCLAW_HOME setup. After the fix the
    // active media root is OPENCLAW_HOME, so a file under HOME is no longer
    // implicitly allowed unless it remaps via the existing workspace fallback.
    // Use a unique subdirectory so we never collide with real user media.
    const stale = `qqbot-stale-${process.pid}-${Date.now()}.png`;
    const homeOnlyFile = path.join(realOsHome, ".openclaw", "media", "qqbot", stale);
    tempPaths.push(homeOnlyFile);
    fs.mkdirSync(path.dirname(homeOnlyFile), { recursive: true });
    fs.writeFileSync(homeOnlyFile, "image", "utf8");

    expect(resolveQQBotPayloadLocalFilePath(homeOnlyFile)).toBeNull();
  });

  it("remaps workspace paths under either HOME or OPENCLAW_HOME to the OPENCLAW_HOME media root", () => {
    const fakeOpenclawHome = makeFakeOpenclawHome();
    vi.stubEnv("OPENCLAW_HOME", fakeOpenclawHome);

    const baseName = `remap-${process.pid}-${Date.now()}`;

    // Real file lives under the OPENCLAW_HOME media tree.
    const mediaFile = path.join(
      fakeOpenclawHome,
      ".openclaw",
      "media",
      "qqbot",
      "downloads",
      baseName,
      "remap.png",
    );
    fs.mkdirSync(path.dirname(mediaFile), { recursive: true });
    fs.writeFileSync(mediaFile, "image", "utf8");

    // Agent that only knows the HOME-relative workspace path should still
    // resolve to the real file thanks to the dual-tree workspace fallback.
    const homeWorkspaceDir = path.join(realOsHome, ".openclaw", "workspace", "qqbot");
    const homeWorkspacePath = path.join(homeWorkspaceDir, "downloads", baseName, "remap.png");
    // Track for cleanup; we only created the unique baseName subdir indirectly
    // through resolveQQBotLocalMediaPath, which does NOT actually create the
    // HOME-side path, so nothing to clean up there beyond the OPENCLAW_HOME tree.
    expect(resolveQQBotLocalMediaPath(homeWorkspacePath)).toBe(mediaFile);

    // Same path but under OPENCLAW_HOME should also remap.
    const openclawWorkspacePath = path.join(
      fakeOpenclawHome,
      ".openclaw",
      "workspace",
      "qqbot",
      "downloads",
      baseName,
      "remap.png",
    );
    expect(resolveQQBotLocalMediaPath(openclawWorkspacePath)).toBe(mediaFile);
  });
});
