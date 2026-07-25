// Google tests cover oauth plugin behavior.
import { join, parse } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGoogleOAuthCredentialsCache,
  setGoogleOAuthCredentialsFs,
  setGoogleOAuthSettingsFs,
} from "./google-oauth.test-support.js";

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    isWSL2Sync: () => false,
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: {
      url: string;
      init?: RequestInit;
      fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    }) => {
      const fetchImpl = params.fetchImpl ?? globalThis.fetch;
      const response = await fetchImpl(params.url, params.init);
      return {
        response,
        finalUrl: params.url,
        release: async () => {},
      };
    },
  };
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/runtime-env");
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockRealpathSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockSettingsExistsSync = vi.fn();
const mockSettingsReadFileSync = vi.fn();

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

describe("isGeminiCliPersonalOAuth", () => {
  const ENV_KEYS = ["GOOGLE_GENAI_USE_GCA"] as const;

  let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string>>;
  let isGeminiCliPersonalOAuth: typeof import("./oauth.settings.js").isGeminiCliPersonalOAuth;

  beforeAll(async () => {
    ({ isGeminiCliPersonalOAuth } = await import("./oauth.settings.js"));
  });

  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    delete process.env.GOOGLE_GENAI_USE_GCA;
    mockSettingsExistsSync.mockReset();
    mockSettingsReadFileSync.mockReset();
    setGoogleOAuthSettingsFs({
      existsSync: (...args) => mockSettingsExistsSync(...args),
      readFileSync: (...args) => mockSettingsReadFileSync(...args),
      homedir: () => "/mock/home",
    });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = envSnapshot[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    setGoogleOAuthSettingsFs();
  });

  it("uses GOOGLE_GENAI_USE_GCA as an oauth-personal fallback when settings are absent", () => {
    process.env.GOOGLE_GENAI_USE_GCA = "true";
    mockSettingsExistsSync.mockReturnValue(false);

    expect(isGeminiCliPersonalOAuth()).toBe(true);
  });

  it("prefers settings auth selection over the GOOGLE_GENAI_USE_GCA fallback", () => {
    process.env.GOOGLE_GENAI_USE_GCA = "true";
    mockSettingsExistsSync.mockReturnValue(true);
    mockSettingsReadFileSync.mockReturnValue(
      JSON.stringify({
        security: {
          auth: {
            selectedType: "oauth-code-assist",
          },
        },
      }),
    );

    expect(isGeminiCliPersonalOAuth()).toBe(false);
  });

  it("reads the nested security auth selection from ~/.gemini/settings.json", () => {
    mockSettingsExistsSync.mockReturnValue(true);
    mockSettingsReadFileSync.mockReturnValue(
      JSON.stringify({
        security: {
          auth: {
            selectedType: "oauth-personal",
          },
        },
      }),
    );

    expect(isGeminiCliPersonalOAuth()).toBe(true);
  });

  it("falls back to legacy top-level selectedAuthType keys", () => {
    mockSettingsExistsSync.mockReturnValue(true);
    mockSettingsReadFileSync.mockReturnValue(
      JSON.stringify({ selectedAuthType: "oauth-personal" }),
    );

    expect(isGeminiCliPersonalOAuth()).toBe(true);
  });
});

describe("resolveOAuthClientConfig", () => {
  const ENV_KEYS = [
    "OPENCLAW_GEMINI_OAUTH_CLIENT_ID",
    "OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
    "GEMINI_CLI_OAUTH_CLIENT_ID",
    "GEMINI_CLI_OAUTH_CLIENT_SECRET",
  ] as const;
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
  let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string>>;
  let resolveOAuthClientConfig: typeof import("./oauth.credentials.js").resolveOAuthClientConfig;

  function resolveExtractedCredentialsOrNull() {
    try {
      return resolveOAuthClientConfig();
    } catch {
      return null;
    }
  }

  async function installMockFs() {
    setGoogleOAuthCredentialsFs({
      existsSync: (...args) => mockExistsSync(...args),
      readFileSync: (...args) => mockReadFileSync(...args),
      realpathSync: (...args) => mockRealpathSync(...args),
      readdirSync: (...args) => mockReaddirSync(...args),
    });
  }

  function makeFakeLayout() {
    const binDir = join(rootDir, "fake", "bin");
    const geminiPath = join(binDir, "gemini");
    const resolvedPath = join(
      rootDir,
      "fake",
      "lib",
      "node_modules",
      "@google",
      "gemini-cli",
      "dist",
      "index.js",
    );
    const oauth2Path = join(
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

    return { binDir, geminiPath, resolvedPath, oauth2Path };
  }

  function installGeminiLayout(params: {
    oauth2Exists?: boolean;
    oauth2Content?: string;
    readdir?: string[];
  }) {
    const layout = makeFakeLayout();
    process.env.PATH = layout.binDir;

    // resolveGeminiCliDirs checks package.json to validate candidate directories
    const geminiCliDir = join(rootDir, "fake", "lib", "node_modules", "@google", "gemini-cli");
    const packageJsonPath = normalizePath(join(geminiCliDir, "package.json"));

    mockExistsSync.mockImplementation((p: string) => {
      const normalized = normalizePath(p);
      if (normalized === normalizePath(layout.geminiPath)) {
        return true;
      }
      if (normalized === packageJsonPath) {
        return true;
      }
      if (params.oauth2Exists && normalized === normalizePath(layout.oauth2Path)) {
        return true;
      }
      return false;
    });
    mockRealpathSync.mockReturnValue(layout.resolvedPath);
    if (params.oauth2Content !== undefined) {
      mockReadFileSync.mockReturnValue(params.oauth2Content);
    }
    if (params.readdir) {
      mockReaddirSync.mockReturnValue(params.readdir);
    }

    return layout;
  }

  function installNpmShimLayout(params: { oauth2Exists?: boolean; oauth2Content?: string }) {
    const binDir = join(rootDir, "fake", "npm-bin");
    const geminiPath = join(binDir, "gemini");
    const resolvedPath = geminiPath;
    const geminiCliDir = join(binDir, "node_modules", "@google", "gemini-cli");
    const oauth2Path = join(
      geminiCliDir,
      "node_modules",
      "@google",
      "gemini-cli-core",
      "dist",
      "src",
      "code_assist",
      "oauth2.js",
    );
    const packageJsonPath = normalizePath(join(geminiCliDir, "package.json"));
    process.env.PATH = binDir;

    mockExistsSync.mockImplementation((p: string) => {
      const normalized = normalizePath(p);
      if (normalized === normalizePath(geminiPath)) {
        return true;
      }
      if (normalized === packageJsonPath) {
        return true;
      }
      if (params.oauth2Exists && normalized === normalizePath(oauth2Path)) {
        return true;
      }
      return false;
    });
    mockRealpathSync.mockReturnValue(resolvedPath);
    if (params.oauth2Content !== undefined) {
      mockReadFileSync.mockReturnValue(params.oauth2Content);
    }
  }

  function installBundledNpmLayout(params: { bundleContent: string }) {
    const binDir = join(rootDir, "fake", "npm-bundle-bin");
    const geminiPath = join(binDir, "gemini");
    const resolvedPath = geminiPath;
    const geminiCliDir = join(binDir, "node_modules", "@google", "gemini-cli");
    const packageJsonPath = normalizePath(join(geminiCliDir, "package.json"));
    const bundleDir = join(geminiCliDir, "bundle");
    const chunkPath = join(bundleDir, "chunk-ABC123.js");

    process.env.PATH = binDir;
    mockExistsSync.mockImplementation((p: string) => {
      const normalized = normalizePath(p);
      return (
        normalized === normalizePath(geminiPath) ||
        normalized === packageJsonPath ||
        normalized === normalizePath(bundleDir)
      );
    });
    mockRealpathSync.mockReturnValue(resolvedPath);
    mockReaddirSync.mockImplementation((p: string) => {
      if (normalizePath(p) === normalizePath(bundleDir)) {
        return [dirent("chunk-ABC123.js", false)];
      }
      return [];
    });
    mockReadFileSync.mockImplementation((p: string) => {
      if (normalizePath(p) === normalizePath(chunkPath)) {
        return params.bundleContent;
      }
      throw new Error(`Unexpected read for ${p}`);
    });
  }

  function installHomebrewLibexecLayout(params: { oauth2Content: string }) {
    const brewPrefix = join(rootDir, "opt", "homebrew");
    const cellarRoot = join(brewPrefix, "Cellar", "gemini-cli", "1.2.3");
    const binDir = join(brewPrefix, "bin");
    const geminiPath = join(binDir, "gemini");
    const resolvedPath = join(cellarRoot, "libexec", "bin", "gemini");
    const geminiCliDir = join(
      cellarRoot,
      "libexec",
      "lib",
      "node_modules",
      "@google",
      "gemini-cli",
    );
    const packageJsonPath = normalizePath(join(geminiCliDir, "package.json"));
    const oauth2Path = join(
      geminiCliDir,
      "node_modules",
      "@google",
      "gemini-cli-core",
      "dist",
      "src",
      "code_assist",
      "oauth2.js",
    );

    process.env.PATH = binDir;
    mockExistsSync.mockImplementation((p: string) => {
      const normalized = normalizePath(p);
      return (
        normalized === normalizePath(geminiPath) ||
        normalized === packageJsonPath ||
        normalized === normalizePath(oauth2Path)
      );
    });
    mockRealpathSync.mockReturnValue(resolvedPath);
    mockReadFileSync.mockImplementation((p: string) => {
      if (normalizePath(p) === normalizePath(oauth2Path)) {
        return params.oauth2Content;
      }
      throw new Error(`Unexpected read for ${p}`);
    });
  }

  function installWindowsNvmLayoutWithUnrelatedOauth(params: {
    oauth2Content: string;
    unrelatedOauth2Content: string;
  }) {
    const nvmRoot = join(rootDir, "fake", "Users", "lobster", "AppData", "Local", "nvm");
    const versionDir = join(nvmRoot, "v24.1.0");
    const geminiPath = join(versionDir, process.platform === "win32" ? "gemini.cmd" : "gemini");
    const resolvedPath = geminiPath;
    const geminiCliDir = join(versionDir, "node_modules", "@google", "gemini-cli");
    const packageJsonPath = normalizePath(join(geminiCliDir, "package.json"));
    const oauth2Path = join(
      geminiCliDir,
      "node_modules",
      "@google",
      "gemini-cli-core",
      "dist",
      "src",
      "code_assist",
      "oauth2.js",
    );
    const unrelatedOauth2Path = join(
      nvmRoot,
      "node_modules",
      "discord-api-types",
      "payloads",
      "v10",
      "oauth2.js",
    );

    process.env.PATH = versionDir;
    mockExistsSync.mockImplementation((p: string) => {
      const normalized = normalizePath(p);
      return (
        normalized === normalizePath(geminiPath) ||
        normalized === packageJsonPath ||
        normalized === normalizePath(oauth2Path)
      );
    });
    mockRealpathSync.mockReturnValue(resolvedPath);
    mockReadFileSync.mockImplementation((p: string) => {
      const normalized = normalizePath(p);
      if (normalized === normalizePath(oauth2Path)) {
        return params.oauth2Content;
      }
      if (normalized === normalizePath(unrelatedOauth2Path)) {
        return params.unrelatedOauth2Content;
      }
      throw new Error(`Unexpected read for ${p}`);
    });
    mockReaddirSync.mockImplementation((p: string) => {
      const normalized = normalizePath(p);
      if (normalized === normalizePath(nvmRoot)) {
        return [dirent("node_modules", true)];
      }
      if (normalized === normalizePath(join(nvmRoot, "node_modules"))) {
        return [dirent("discord-api-types", true)];
      }
      if (normalized === normalizePath(join(nvmRoot, "node_modules", "discord-api-types"))) {
        return [dirent("payloads", true)];
      }
      if (
        normalized === normalizePath(join(nvmRoot, "node_modules", "discord-api-types", "payloads"))
      ) {
        return [dirent("v10", true)];
      }
      if (
        normalized ===
        normalizePath(join(nvmRoot, "node_modules", "discord-api-types", "payloads", "v10"))
      ) {
        return [dirent("oauth2.js", false)];
      }
      return [];
    });

    return { unrelatedOauth2Path };
  }

  function dirent(name: string, isDirectory: boolean) {
    return {
      name,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isDirectory: () => isDirectory,
      isFIFO: () => false,
      isFile: () => !isDirectory,
      isSocket: () => false,
      isSymbolicLink: () => false,
    };
  }

  function expectFakeCliCredentials(result: unknown) {
    expect(result).toEqual({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
    });
  }

  beforeAll(async () => {
    ({ resolveOAuthClientConfig } = await import("./oauth.credentials.js"));
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    originalPath = process.env.PATH;
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    await installMockFs();
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    for (const key of ENV_KEYS) {
      const value = envSnapshot[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    setGoogleOAuthCredentialsFs();
  });

  it("returns null when gemini binary is not in PATH", () => {
    process.env.PATH = "/nonexistent";
    mockExistsSync.mockReturnValue(false);

    clearGoogleOAuthCredentialsCache();
    expect(resolveExtractedCredentialsOrNull()).toBeNull();
  });

  it("includes missing binary details when resolving OAuth client config", async () => {
    process.env.PATH = "/nonexistent";
    mockExistsSync.mockReturnValue(false);

    clearGoogleOAuthCredentialsCache();
    expect(() => resolveOAuthClientConfig()).toThrow(
      /Details: Gemini CLI binary was not found in PATH/,
    );
  });

  it("extracts credentials from oauth2.js in known path", () => {
    installGeminiLayout({ oauth2Exists: true, oauth2Content: FAKE_OAUTH2_CONTENT });

    clearGoogleOAuthCredentialsCache();
    const result = resolveExtractedCredentialsOrNull();

    expectFakeCliCredentials(result);
  });

  it("extracts credentials when PATH entry is an npm global shim", () => {
    installNpmShimLayout({ oauth2Exists: true, oauth2Content: FAKE_OAUTH2_CONTENT });

    clearGoogleOAuthCredentialsCache();
    const result = resolveExtractedCredentialsOrNull();

    expectFakeCliCredentials(result);
  });

  it("extracts credentials from bundled npm installs", () => {
    installBundledNpmLayout({
      bundleContent: `
        const OAUTH_CLIENT_ID = "${FAKE_CLIENT_ID}";
        const OAUTH_CLIENT_SECRET = "${FAKE_CLIENT_SECRET}";
      `,
    });

    clearGoogleOAuthCredentialsCache();
    const result = resolveExtractedCredentialsOrNull();

    expectFakeCliCredentials(result);
  });

  it("extracts credentials from Homebrew libexec installs", () => {
    installHomebrewLibexecLayout({ oauth2Content: FAKE_OAUTH2_CONTENT });

    clearGoogleOAuthCredentialsCache();
    const result = resolveExtractedCredentialsOrNull();

    expectFakeCliCredentials(result);
  });

  it("returns null when oauth2.js cannot be found", () => {
    installGeminiLayout({ oauth2Exists: false, readdir: [] });

    clearGoogleOAuthCredentialsCache();
    expect(resolveExtractedCredentialsOrNull()).toBeNull();
  });

  it("includes missing oauth2.js details when resolving OAuth client config", async () => {
    installGeminiLayout({ oauth2Exists: false, readdir: [] });

    clearGoogleOAuthCredentialsCache();
    expect(() => resolveOAuthClientConfig()).toThrow(/Could not locate oauth2\.js/);
    expect(() => resolveOAuthClientConfig()).toThrow(/recursiveSearchDepth=10/);
  });

  it("returns null when oauth2.js lacks credentials", () => {
    installGeminiLayout({ oauth2Exists: true, oauth2Content: "// no credentials here" });

    clearGoogleOAuthCredentialsCache();
    expect(resolveExtractedCredentialsOrNull()).toBeNull();
  });

  it("includes parse failure details when resolving OAuth client config", async () => {
    installGeminiLayout({
      oauth2Exists: true,
      oauth2Content: "// no credentials here",
      readdir: [],
    });

    clearGoogleOAuthCredentialsCache();
    expect(() => resolveOAuthClientConfig()).toThrow(
      /Candidate credential files did not contain a parseable OAuth client id\/secret/,
    );
  });

  it("includes unexpected extraction exception details when resolving OAuth client config", async () => {
    installGeminiLayout({ oauth2Exists: true, readdir: [] });
    mockReadFileSync.mockImplementation(() => {
      throw new Error("mock read failure");
    });

    clearGoogleOAuthCredentialsCache();
    expect(() => resolveOAuthClientConfig()).toThrow(
      /Unexpected errors occurred while reading candidate credential files\/directories/,
    );
    expect(() => resolveOAuthClientConfig()).toThrow(/mock read failure/);
  });

  it("caches credentials after first extraction", () => {
    installGeminiLayout({ oauth2Exists: true, oauth2Content: FAKE_OAUTH2_CONTENT });

    clearGoogleOAuthCredentialsCache();

    // First call
    const result1 = resolveExtractedCredentialsOrNull();
    expectFakeCliCredentials(result1);

    // Second call should use cache (readFileSync not called again)
    const readCount = mockReadFileSync.mock.calls.length;
    const result2 = resolveExtractedCredentialsOrNull();
    expect(result2).toEqual(result1);
    expect(mockReadFileSync.mock.calls.length).toBe(readCount);
  });

  it("skips unrelated oauth2.js files when gemini resolves inside a Windows nvm root", () => {
    const { unrelatedOauth2Path } = installWindowsNvmLayoutWithUnrelatedOauth({
      oauth2Content: FAKE_OAUTH2_CONTENT,
      unrelatedOauth2Content: "// unrelated oauth file",
    });

    clearGoogleOAuthCredentialsCache();
    const result = resolveExtractedCredentialsOrNull();

    expectFakeCliCredentials(result);
    expect(
      mockReadFileSync.mock.calls.some(
        ([path]) => normalizePath(String(path)) === normalizePath(unrelatedOauth2Path),
      ),
    ).toBe(false);
  });
});

describe("loginGeminiCliOAuth", () => {
  const TOKEN_URL = "https://oauth2.googleapis.com/token";
  const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
  const LOAD_PROD = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
  const LOAD_DAILY = "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist";
  const LOAD_AUTOPUSH =
    "https://autopush-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist";

  const ENV_KEYS = [
    "OPENCLAW_GEMINI_OAUTH_CLIENT_ID",
    "OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
    "GEMINI_CLI_OAUTH_CLIENT_ID",
    "GEMINI_CLI_OAUTH_CLIENT_SECRET",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_PROJECT_ID",
    "GOOGLE_GENAI_USE_GCA",
  ] as const;

  const EXPECTED_LOAD_CODE_ASSIST_METADATA = {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  } as const;
  const OVERSIZED_OAUTH_RESPONSE_BYTES = 17 * 1024 * 1024;

  function getRequestUrl(input: string | URL | Request): string {
    if (typeof input === "string") {
      return input;
    }
    if (input instanceof URL) {
      return input.toString();
    }
    return input.url;
  }

  function getHeaderValue(headers: HeadersInit | undefined, name: string): string | undefined {
    if (!headers) {
      return undefined;
    }
    if (headers instanceof Headers) {
      return headers.get(name) ?? undefined;
    }
    if (Array.isArray(headers)) {
      return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    }
    return headers[name];
  }

  function responseJson(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function oversizedJsonStringFieldResponse(params: {
    prefix: string;
    suffix: string;
    targetBytes?: number;
  }): Response {
    const encoder = new TextEncoder();
    const prefix = encoder.encode(params.prefix);
    const suffix = encoder.encode(params.suffix);
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const targetBytes = params.targetBytes ?? OVERSIZED_OAUTH_RESPONSE_BYTES;
    let sentBytes = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(prefix);
          sentBytes += prefix.byteLength;
        },
        pull(controller) {
          if (sentBytes >= targetBytes) {
            controller.enqueue(suffix);
            controller.close();
            return;
          }
          controller.enqueue(chunk);
          sentBytes += chunk.byteLength;
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  function responseTextBodyWithTextTrap(body: string, status = 500) {
    const response = new Response(body, {
      status,
      headers: { "Content-Type": "text/plain" },
    });
    const text = vi
      .spyOn(response, "text")
      .mockRejectedValue(new Error("unexpected response.text() call"));
    return { response, text };
  }

  function tokenResponse(): Response {
    return responseJson({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
    });
  }

  function userInfoResponse(): Response {
    return responseJson({ email: "lobster@openclaw.ai" });
  }

  type RecordedFetchRequest = {
    url: string;
    init?: RequestInit;
  };

  function installGeminiOAuthFetchMock(
    handleRequest: (request: RecordedFetchRequest) => Response | undefined,
    options: { tokenResponse?: () => Response } = {},
  ) {
    const requests: RecordedFetchRequest[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = { url: getRequestUrl(input), init };
      requests.push(request);

      if (request.url === TOKEN_URL) {
        return (options.tokenResponse ?? tokenResponse)();
      }
      if (request.url === USERINFO_URL) {
        return userInfoResponse();
      }

      const response = handleRequest(request);
      if (response) {
        return response;
      }
      throw new Error(`Unexpected request: ${request.url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, requests };
  }

  function getFormField(body: RequestInit["body"], name: string): string | null {
    if (!(body instanceof URLSearchParams)) {
      throw new Error("Expected URLSearchParams body");
    }
    return body.get(name);
  }

  function parseJsonString(value: unknown, label: string): unknown {
    if (typeof value !== "string") {
      throw new Error(`Expected ${label} JSON string`);
    }
    return JSON.parse(value);
  }

  function requireString(value: string | null | undefined, label: string): string {
    if (!value) {
      throw new Error(`Expected ${label}`);
    }
    return value;
  }

  function requireRecordedRequest(
    request: RecordedFetchRequest | undefined,
    label: string,
  ): RecordedFetchRequest {
    if (!request) {
      throw new Error(`Expected ${label} request`);
    }
    return request;
  }

  type LoginGeminiCliOAuthFn = (options: {
    isRemote: boolean;
    openUrl: () => Promise<void>;
    log: (msg: string) => void;
    note: (message?: string, title?: string) => Promise<void>;
    prompt: () => Promise<string>;
    progress: { update: () => void; stop: () => void };
  }) => Promise<{ projectId?: string }>;

  async function runRemoteLoginWithCapturedAuthUrl(loginGeminiCliOAuth: LoginGeminiCliOAuthFn) {
    let authUrl = "";
    const notes: string[] = [];
    const result = await loginGeminiCliOAuth({
      isRemote: true,
      openUrl: async () => {},
      log: (msg) => {
        const found = msg.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^\s]+/);
        if (found?.[0]) {
          authUrl = found[0];
        }
      },
      note: async (message?: string) => {
        if (message) {
          notes.push(message);
        }
      },
      prompt: async () => {
        const state = new URL(authUrl).searchParams.get("state");
        return `http://localhost:8085/oauth2callback?code=oauth-code&state=${state}`;
      },
      progress: { update: () => {}, stop: () => {} },
    });
    return { result, authUrl, notes };
  }

  async function runProjectDiscoveryExpectingProjectId(projectId: string) {
    const { resolveGoogleOAuthIdentity } = await import("./oauth.project.js");
    const result = await resolveGoogleOAuthIdentity("access-token");
    expect(result.projectId).toBe(projectId);
  }

  it("propagates cancellation through Gemini identity and project discovery", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        signals.push(init?.signal);
        if (url === USERINFO_URL) {
          return new Response(JSON.stringify({ email: "test@example.com" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        controller.abort(new Error("setup cancelled"));
        throw controller.signal.reason;
      }),
    );

    const { resolveGoogleOAuthIdentity } = await import("./oauth.project.js");
    await expect(resolveGoogleOAuthIdentity("access-token", controller.signal)).rejects.toThrow(
      "setup cancelled",
    );
    expect(signals).toEqual([controller.signal, controller.signal]);
  });

  let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string>>;

  beforeAll(async () => {
    await import("./oauth.settings.js");
  });

  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.OPENCLAW_GEMINI_OAUTH_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
    process.env.OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET = "GOCSPX-test-client-secret"; // pragma: allowlist secret
    delete process.env.GEMINI_CLI_OAUTH_CLIENT_ID;
    delete process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT_ID;
    delete process.env.GOOGLE_GENAI_USE_GCA;
    mockSettingsExistsSync.mockReset();
    mockSettingsReadFileSync.mockReset();
    setGoogleOAuthSettingsFs({
      existsSync: (...args) => mockSettingsExistsSync(...args),
      readFileSync: (...args) => mockSettingsReadFileSync(...args),
      homedir: () => "/mock/home",
    });
    mockSettingsExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = envSnapshot[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    setGoogleOAuthSettingsFs();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("falls back across loadCodeAssist endpoints with aligned headers and metadata", async () => {
    const { requests } = installGeminiOAuthFetchMock(({ url }) => {
      if (url === LOAD_PROD) {
        return responseJson({ error: { message: "temporary failure" } }, 503);
      }
      if (url === LOAD_DAILY) {
        return responseJson({
          currentTier: { id: "standard-tier" },
          cloudaicompanionProject: { id: "daily-project" },
        });
      }
      return undefined;
    });

    await runProjectDiscoveryExpectingProjectId("daily-project");
    const loadRequests = requests.filter((request) =>
      request.url.includes("v1internal:loadCodeAssist"),
    );
    expect(loadRequests.map((request) => request.url)).toEqual([LOAD_PROD, LOAD_DAILY]);

    const firstHeaders = loadRequests[0]?.init?.headers;
    expect(getHeaderValue(firstHeaders, "X-Goog-Api-Client")).toBe(
      `gl-node/${process.versions.node}`,
    );

    const clientMetadata = requireString(
      getHeaderValue(firstHeaders, "Client-Metadata"),
      "Client-Metadata",
    );
    expect(parseJsonString(clientMetadata, "Client-Metadata")).toEqual(
      EXPECTED_LOAD_CODE_ASSIST_METADATA,
    );

    const loadBody = loadRequests[0]?.init?.body;
    const body = parseJsonString(loadBody, "loadCodeAssist body");
    expect(body).toEqual({
      metadata: EXPECTED_LOAD_CODE_ASSIST_METADATA,
    });
  });

  it("keeps OAuth state separate from the PKCE verifier during manual login", async () => {
    const { requests } = installGeminiOAuthFetchMock(({ url }) => {
      if (url === LOAD_PROD) {
        return responseJson({
          currentTier: { id: "standard-tier" },
          cloudaicompanionProject: { id: "prod-project" },
        });
      }
      return undefined;
    });

    const { loginGeminiCliOAuth } = await import("./oauth.js");
    const { authUrl, notes } = await runRemoteLoginWithCapturedAuthUrl(loginGeminiCliOAuth);

    expect(notes).toContainEqual(expect.stringContaining(authUrl));

    const authState = requireString(new URL(authUrl).searchParams.get("state"), "OAuth state");

    const tokenRequest = requireRecordedRequest(
      requests.find((request) => request.url === TOKEN_URL),
      "token",
    );
    const codeVerifier = requireString(
      getFormField(tokenRequest.init?.body, "code_verifier"),
      "PKCE code verifier",
    );
    expect(codeVerifier).not.toBe(authState);
  });

  it("rejects manual callback input when the returned state does not match", async () => {
    const { loginGeminiCliOAuth } = await import("./oauth.js");

    await expect(
      loginGeminiCliOAuth({
        isRemote: true,
        openUrl: async () => {},
        log: () => {},
        note: async () => {},
        prompt: async () =>
          "http://localhost:8085/oauth2callback?code=oauth-code&state=wrong-state",
        progress: { update: () => {}, stop: () => {} },
      }),
    ).rejects.toThrow("OAuth state mismatch - please try again");
  });

  it("rejects first login when project discovery fails and no stored identity exists", async () => {
    const { requests } = installGeminiOAuthFetchMock(({ url }) => {
      if ([LOAD_PROD, LOAD_DAILY, LOAD_AUTOPUSH].includes(url)) {
        return responseJson({ error: { message: "unavailable" } }, 503);
      }
      return undefined;
    });

    const { exchangeCodeForTokens } = await import("./oauth.token.js");
    await expect(exchangeCodeForTokens("oauth-code", "pkce-verifier")).rejects.toThrow(
      /loadCodeAssist failed/i,
    );
    expect(requests.filter(({ url }) => url.includes("v1internal:loadCodeAssist"))).toHaveLength(3);
  });

  it.each([
    [
      "exchange",
      "x",
      async () =>
        (await import("./oauth.token.js")).exchangeCodeForTokens("oauth-code", "pkce-verifier"),
    ],
    [
      "refresh",
      "y",
      async () =>
        (await import("./oauth.token.js")).refreshTokensForGeminiCli({ refresh: "refresh-token" }),
    ],
  ])("bounds token %s error bodies without using response.text()", async (_flow, fill, request) => {
    const { response, text } = responseTextBodyWithTextTrap(fill.repeat(32 * 1024), 500);
    installGeminiOAuthFetchMock(() => undefined, { tokenResponse: () => response });

    const error = await request().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`Token exchange failed: ${fill.repeat(8 * 1024)}`);
    expect(text).not.toHaveBeenCalled();
  });

  it("falls back to GOOGLE_CLOUD_PROJECT when all loadCodeAssist endpoints fail", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "env-project";

    const { requests } = installGeminiOAuthFetchMock(({ url }) => {
      if ([LOAD_PROD, LOAD_DAILY, LOAD_AUTOPUSH].includes(url)) {
        return responseJson({ error: { message: "unavailable" } }, 503);
      }
      return undefined;
    });

    await runProjectDiscoveryExpectingProjectId("env-project");
    expect(countMatching(requests, ({ url }) => url.includes("v1internal:loadCodeAssist"))).toBe(3);
    expect(countMatching(requests, ({ url }) => url.includes("v1internal:onboardUser"))).toBe(0);
  });

  it("skips loadCodeAssist entirely when Gemini CLI is configured for personal OAuth", async () => {
    mockSettingsExistsSync.mockReturnValue(true);
    mockSettingsReadFileSync.mockReturnValue(
      JSON.stringify({
        security: {
          auth: {
            selectedType: "oauth-personal",
          },
        },
      }),
    );

    const { requests } = installGeminiOAuthFetchMock(() => undefined);
    const { exchangeCodeForTokens } = await import("./oauth.token.js");
    const result = await exchangeCodeForTokens("oauth-code", "pkce-verifier");

    expect(result.projectId).toBeUndefined();
    expect(requests.map(({ url }) => url)).toEqual([TOKEN_URL, USERINFO_URL]);
  });

  it("refreshes Gemini CLI OAuth tokens without loadCodeAssist in personal OAuth mode", async () => {
    mockSettingsExistsSync.mockReturnValue(true);
    mockSettingsReadFileSync.mockReturnValue(
      JSON.stringify({
        security: {
          auth: {
            selectedType: "oauth-personal",
          },
        },
      }),
    );

    const { requests } = installGeminiOAuthFetchMock(() => undefined);
    const { refreshTokensForGeminiCli } = await import("./oauth.token.js");
    const result = await refreshTokensForGeminiCli({
      refresh: "refresh-token",
      email: "lobster@openclaw.ai",
    });

    expect(result).toMatchObject({
      access: "access-token",
      refresh: "refresh-token",
      email: "lobster@openclaw.ai",
      projectId: undefined,
    });
    expect(requests.map(({ url }) => url)).toEqual([TOKEN_URL, USERINFO_URL]);
  });

  it("keeps malformed token expiry values out of refreshed Gemini CLI credentials", async () => {
    mockSettingsExistsSync.mockReturnValue(true);
    mockSettingsReadFileSync.mockReturnValue(
      JSON.stringify({
        security: {
          auth: {
            selectedType: "oauth-personal",
          },
        },
      }),
    );

    const beforeRefresh = Date.now();
    installGeminiOAuthFetchMock(() => undefined, {
      tokenResponse: () =>
        responseJson({
          access_token: "access-token",
          expires_in: Number.NaN,
        }),
    });
    const { refreshTokensForGeminiCli } = await import("./oauth.token.js");
    const result = await refreshTokensForGeminiCli({
      refresh: "refresh-token",
      email: "lobster@openclaw.ai",
    });

    expect(Number.isFinite(result.expires)).toBe(true);
    expect(result.expires).toBeLessThanOrEqual(beforeRefresh);
  });

  it("keeps invalid clocks out of refreshed Gemini CLI credential expiry", async () => {
    mockSettingsExistsSync.mockReturnValue(true);
    mockSettingsReadFileSync.mockReturnValue(
      JSON.stringify({
        security: {
          auth: {
            selectedType: "oauth-personal",
          },
        },
      }),
    );

    installGeminiOAuthFetchMock(() => undefined, {
      tokenResponse: () =>
        responseJson({
          access_token: "access-token",
          expires_in: 3600,
        }),
    });
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      const { refreshTokensForGeminiCli } = await import("./oauth.token.js");
      const result = await refreshTokensForGeminiCli({
        refresh: "refresh-token",
        email: "lobster@openclaw.ai",
      });

      expect(result.expires).toBe(0);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("keeps unsafe token expiry values out of refreshed Gemini CLI credentials", async () => {
    mockSettingsExistsSync.mockReturnValue(true);
    mockSettingsReadFileSync.mockReturnValue(
      JSON.stringify({
        security: {
          auth: {
            selectedType: "oauth-personal",
          },
        },
      }),
    );

    const beforeRefresh = Date.now();
    installGeminiOAuthFetchMock(() => undefined, {
      tokenResponse: () =>
        responseJson({
          access_token: "access-token",
          expires_in: Number.MAX_SAFE_INTEGER,
        }),
    });
    const { refreshTokensForGeminiCli } = await import("./oauth.token.js");
    const result = await refreshTokensForGeminiCli({
      refresh: "refresh-token",
      email: "lobster@openclaw.ai",
    });

    expect(Number.isSafeInteger(result.expires)).toBe(true);
    expect(result.expires).toBeLessThanOrEqual(beforeRefresh);
  });

  it("rejects an oversized token exchange response body", async () => {
    // End-to-end OAuth path: oversized upstream bodies fail closed before auth
    // completes. After #97628 the shared fetchWithTimeout cap fires first;
    // readProviderJsonResponse remains the labeled parse boundary afterward.
    installGeminiOAuthFetchMock(() => undefined, {
      tokenResponse: () =>
        oversizedJsonStringFieldResponse({
          prefix: '{"access_token":"',
          suffix: '","refresh_token":"r","expires_in":3600}',
        }),
    });

    const { exchangeCodeForTokens } = await import("./oauth.token.js");
    await expect(exchangeCodeForTokens("oauth-code", "pkce-verifier")).rejects.toThrow(
      /google HTTP fetch: body exceeds|google\.token.*exceeds|Content too large/,
    );
  });

  it("rejects an oversized token body at the JSON parse boundary", async () => {
    // Defense-in-depth: if fetchWithTimeout already returned a buffered Response,
    // readProviderJsonResponse still caps JSON.parse on the OAuth token path.
    vi.resetModules();
    const oauthHttp = await import("./oauth.http.js");
    const originalFetchWithTimeout = oauthHttp.fetchWithTimeout;
    vi.spyOn(oauthHttp, "fetchWithTimeout").mockImplementation(async (url, init, timeoutMs) => {
      if (url === TOKEN_URL) {
        return oversizedJsonStringFieldResponse({
          prefix: '{"access_token":"',
          suffix: '","refresh_token":"r","expires_in":3600}',
        });
      }
      return originalFetchWithTimeout(url, init, timeoutMs);
    });
    installGeminiOAuthFetchMock(() => undefined);

    const { exchangeCodeForTokens } = await import("./oauth.token.js");
    await expect(exchangeCodeForTokens("oauth-code", "pkce-verifier")).rejects.toThrow(
      /google\.token.*exceeds|Content too large/,
    );
  });

  it("rejects an oversized loadCodeAssist success response body", async () => {
    // discoverProject loops over all 3 LOAD endpoints; each must return the
    // oversized body so that bound errors propagate for the whole loop.
    const oversizedResponse = () =>
      oversizedJsonStringFieldResponse({
        prefix: '{"currentTier":{"id":"standard-tier"},"cloudaicompanionProject":{"id":"',
        suffix: '"}}',
      });
    installGeminiOAuthFetchMock(({ url }) => {
      if (url === LOAD_PROD || url === LOAD_DAILY || url === LOAD_AUTOPUSH) {
        return oversizedResponse();
      }
      return undefined;
    });

    const { resolveGoogleOAuthIdentity } = await import("./oauth.project.js");
    await expect(resolveGoogleOAuthIdentity("access-token")).rejects.toThrow(
      /google HTTP fetch: body exceeds|google\.load-code-assist.*exceeds|Content too large/,
    );
  });

  it("swallows bound error on oversized userinfo body and returns undefined email", async () => {
    // getUserEmail catches all errors; an oversized userinfo body should not
    // propagate but email must be undefined. After #97628 the fetch cap may
    // truncate the upstream body before parse, so the swallowed error can be
    // either a labeled size cap or malformed JSON — either proves the bound fired.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === USERINFO_URL) {
          return oversizedJsonStringFieldResponse({
            prefix: '{"email":"',
            suffix: '"}',
          });
        }
        if (url === LOAD_PROD) {
          return new Response(
            JSON.stringify({
              currentTier: { id: "standard-tier" },
              cloudaicompanionProject: { id: "proj-bound-test" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), { status: 503 });
      }),
    );

    const { resolveGoogleOAuthIdentity } = await import("./oauth.project.js");
    const result = await resolveGoogleOAuthIdentity("access-token");
    expect(result.projectId).toBe("proj-bound-test");
    // email is undefined: the bound error was thrown and swallowed by getUserEmail
    expect(result.email).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
