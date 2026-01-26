import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { join, parse } from "node:path";

// Mock fs module before importing the module under test
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockRealpathSync = vi.fn();
const mockReaddirSync = vi.fn();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) => mockExistsSync(...args),
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => mockReadFileSync(...args),
    realpathSync: (...args: Parameters<typeof actual.realpathSync>) => mockRealpathSync(...args),
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => mockReaddirSync(...args),
  };
});

describe("extractGeminiCliCredentials", () => {
  const normalizePath = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const rootDir = parse(process.cwd()).root || "/";
  const FAKE_CLIENT_ID = "123456789-abcdef.apps.googleusercontent.com";
  const FAKE_CLIENT_SECRET = "GOCSPX-FakeSecretValue123";
  const FAKE_OAUTH2_CONTENT = `
    const clientId = "${FAKE_CLIENT_ID}";
    const clientSecret = "${FAKE_CLIENT_SECRET}";
  `;

  let originalPath: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("returns null when gemini binary is not in PATH", async () => {
    process.env.PATH = "/nonexistent";
    mockExistsSync.mockReturnValue(false);

    const { extractGeminiCliCredentials, clearCredentialsCache } = await import("./oauth.js");
    clearCredentialsCache();
    expect(extractGeminiCliCredentials()).toBeNull();
  });

  it("extracts credentials from oauth2.js in known path", async () => {
    const fakeBinDir = join(rootDir, "fake", "bin");
    const fakeGeminiPath = join(fakeBinDir, "gemini");
    const fakeResolvedPath = join(
      rootDir,
      "fake",
      "lib",
      "node_modules",
      "@google",
      "gemini-cli",
      "dist",
      "index.js",
    );
    const fakeOauth2Path = join(
      rootDir,
      "fake",
      "lib",
      "node_modules",
      "@google",
      "gemini-cli",
      "node_modules",
      "@google",
      "gemini-cli-core",
      "dist",
      "src",
      "code_assist",
      "oauth2.js",
    );

    process.env.PATH = fakeBinDir;

    mockExistsSync.mockImplementation((p: string) => {
      const normalized = normalizePath(p);
      if (normalized === normalizePath(fakeGeminiPath)) return true;
      if (normalized === normalizePath(fakeOauth2Path)) return true;
      return false;
    });
    mockRealpathSync.mockReturnValue(fakeResolvedPath);
    mockReadFileSync.mockReturnValue(FAKE_OAUTH2_CONTENT);

    const { extractGeminiCliCredentials, clearCredentialsCache } = await import("./oauth.js");
    clearCredentialsCache();
    const result = extractGeminiCliCredentials();

    expect(result).toEqual({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
    });
  });

  it("returns null when oauth2.js cannot be found", async () => {
    const fakeBinDir = join(rootDir, "fake", "bin");
    const fakeGeminiPath = join(fakeBinDir, "gemini");
    const fakeResolvedPath = join(
      rootDir,
      "fake",
      "lib",
      "node_modules",
      "@google",
      "gemini-cli",
      "dist",
      "index.js",
    );

    process.env.PATH = fakeBinDir;

    mockExistsSync.mockImplementation(
      (p: string) => normalizePath(p) === normalizePath(fakeGeminiPath),
    );
    mockRealpathSync.mockReturnValue(fakeResolvedPath);
    mockReaddirSync.mockReturnValue([]); // Empty directory for recursive search

    const { extractGeminiCliCredentials, clearCredentialsCache } = await import("./oauth.js");
    clearCredentialsCache();
    expect(extractGeminiCliCredentials()).toBeNull();
  });

  it("returns null when oauth2.js lacks credentials", async () => {
    const fakeBinDir = join(rootDir, "fake", "bin");
    const fakeGeminiPath = join(fakeBinDir, "gemini");
    const fakeResolvedPath = join(
      rootDir,
      "fake",
      "lib",
      "node_modules",
      "@google",
      "gemini-cli",
      "dist",
      "index.js",
    );
    const fakeOauth2Path = join(
      rootDir,
      "fake",
      "lib",
      "node_modules",
      "@google",
      "gemini-cli",
      "node_modules",
      "@google",
      "gemini-cli-core",
      "dist",
      "src",
      "code_assist",
      "oauth2.js",
    );

    process.env.PATH = fakeBinDir;

    mockExistsSync.mockImplementation((p: string) => {
      const normalized = normalizePath(p);
      if (normalized === normalizePath(fakeGeminiPath)) return true;
      if (normalized === normalizePath(fakeOauth2Path)) return true;
      return false;
    });
    mockRealpathSync.mockReturnValue(fakeResolvedPath);
    mockReadFileSync.mockReturnValue("// no credentials here");

    const { extractGeminiCliCredentials, clearCredentialsCache } = await import("./oauth.js");
    clearCredentialsCache();
    expect(extractGeminiCliCredentials()).toBeNull();
  });

  it("caches credentials after first extraction", async () => {
    const fakeBinDir = join(rootDir, "fake", "bin");
    const fakeGeminiPath = join(fakeBinDir, "gemini");
    const fakeResolvedPath = join(
      rootDir,
      "fake",
      "lib",
      "node_modules",
      "@google",
      "gemini-cli",
      "dist",
      "index.js",
    );
    const fakeOauth2Path = join(
      rootDir,
      "fake",
      "lib",
      "node_modules",
      "@google",
      "gemini-cli",
      "node_modules",
      "@google",
      "gemini-cli-core",
      "dist",
      "src",
      "code_assist",
      "oauth2.js",
    );

    process.env.PATH = fakeBinDir;

    mockExistsSync.mockImplementation((p: string) => {
      const normalized = normalizePath(p);
      if (normalized === normalizePath(fakeGeminiPath)) return true;
      if (normalized === normalizePath(fakeOauth2Path)) return true;
      return false;
    });
    mockRealpathSync.mockReturnValue(fakeResolvedPath);
    mockReadFileSync.mockReturnValue(FAKE_OAUTH2_CONTENT);

    const { extractGeminiCliCredentials, clearCredentialsCache } = await import("./oauth.js");
    clearCredentialsCache();

    // First call
    const result1 = extractGeminiCliCredentials();
    expect(result1).not.toBeNull();

    // Second call should use cache (readFileSync not called again)
    const readCount = mockReadFileSync.mock.calls.length;
    const result2 = extractGeminiCliCredentials();
    expect(result2).toEqual(result1);
    expect(mockReadFileSync.mock.calls.length).toBe(readCount);
  });
});
