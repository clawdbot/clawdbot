import { join, parse } from "node:path";
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";

vi.mock("../../src/infra/wsl.js", () => ({
  isWSL2Sync: () => false,
}));

vi.mock("../../src/infra/net/fetch-guard.js", () => ({
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
}));

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockRealpathSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockSettingsExistsSync = vi.fn();
const mockSettingsReadFileSync = vi.fn();

describe("resolveGeminiCliSelectedAuthType", () => {
  const ENV_KEYS = ["GOOGLE_GENAI_USE_GCA"] as const;

  let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string>>;
  let resolveGeminiCliSelectedAuthType: typeof import("./oauth.settings.js").resolveGeminiCliSelectedAuthType;
  let setOAuthSettingsFsForTest: typeof import("./oauth.settings.js").setOAuthSettingsFsForTest;

  beforeAll(async () => {
    ({ resolveGeminiCliSelectedAuthType, setOAuthSettingsFsForTest } =
      await import("./oauth.settings.js"));
  });

  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    delete process.env.GOOGLE_GENAI_USE_GCA;
    mockSettingsExistsSync.mockReset();
    mockSettingsReadFileSync.mockReset();
    setOAuthSettingsFsForTest({
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
    setOAuthSettingsFsForTest();
  });

  it("uses GOOGLE_GENAI_USE_GCA as an oauth-personal fallback when settings are absent", () => {
    process.env.GOOGLE_GENAI_USE_GCA = "true";
    mockSettingsExistsSync.mockReturnValue(false);

    expect(resolveGeminiCliSelectedAuthType()).toBe("oauth-personal");
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

    expect(resolveGeminiCliSelectedAuthType()).toBe("oauth-code-assist");
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

    expect(resolveGeminiCliSelectedAuthType()).toBe("oauth-personal");
  });

  it("falls back to legacy top-level selectedAuthType keys", () => {
    mockSettingsExistsSync.mockReturnValue(true);
    mockSettingsReadFileSync.mockReturnValue(
      JSON.stringify({ selectedAuthType: "oauth-personal" }),
    );

    expect(resolveGeminiCliSelectedAuthType()).toBe("oauth-personal");
  });
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
  let extractGeminiCliCredentials: typeof import("./oauth.credentials.js").extractGeminiCliCredentials;
  let clearCredentialsCache: typeof import("./oauth.credentials.js").clearCredentialsCache;
  let setOAuthCredentialsFsForTest: typeof import("./oauth.credentials.js").setOAuthCredentialsFsForTest;

  async function installMockFs() {
    setOAuthCredentialsFsForTest({
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
    ({ extractGeminiCliCredentials, clearCredentialsCache, setOAuthCredentialsFsForTest } =
      await import("./oauth.credentials.js"));
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    originalPath = process.env.PATH;
    await installMockFs();
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    setOAuthCredentialsFsForTest();
  });

  it("returns null when gemini binary is not in PATH", async () => {
    process.env.PATH = "/nonexistent";
    mockExistsSync.mockReturnValue(false);

    clearCredentialsCache();
    expect(extractGeminiCliCredentials()).toBeNull();
  });

  it("extracts credentials from oauth2.js in known path", async () => {
    installGeminiLayout({ oauth2Exists: true, oauth2Content: FAKE_OAUTH2_CONTENT });

    clearCredentialsCache();
    const result = extractGeminiCliCredentials();

    expectFakeCliCredentials(result);
  });

  it("extracts credentials when PATH entry is an npm global shim", async () => {
    installNpmShimLayout({ oauth2Exists: true, oauth2Content: FAKE_OAUTH2_CONTENT });

    clearCredentialsCache();
    const result = extractGeminiCliCredentials();

    expectFakeCliCredentials(result);
  });

  it("extracts credentials from bundled npm installs", async () => {
    installBundledNpmLayout({
      bundleContent: `
        const OAUTH_CLIENT_ID = "${FAKE_CLIENT_ID}";
        const OAUTH_CLIENT_SECRET = "${FAKE_CLIENT_SECRET}";
      `,
    });

    clearCredentialsCache();
    const result = extractGeminiCliCredentials();

    expectFakeCliCredentials(result);
  });

  it("extracts credentials from Homebrew libexec installs", async () => {
    installHomebrewLibexecLayout({ oauth2Content: FAKE_OAUTH2_CONTENT });

    clearCredentialsCache();
    const result = extractGeminiCliCredentials();

    expectFakeCliCredentials(result);
  });

  it("returns null when oauth2.js cannot be found", async () => {
    installGeminiLayout({ oauth2Exists: false, readdir: [] });

    clearCredentialsCache();
    expect(extractGeminiCliCredentials()).toBeNull();
  });

  it("returns null when oauth2.js lacks credentials", async () => {
    installGeminiLayout({ oauth2Exists: true, oauth2Content: "// no credentials here" });

    clearCredentialsCache();
    expect(extractGeminiCliCredentials()).toBeNull();
  });

  it("caches credentials after first extraction", async () => {
    installGeminiLayout({ oauth2Exists: true, oauth2Content: FAKE_OAUTH2_CONTENT });

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

  it("skips unrelated oauth2.js files when gemini resolves inside a Windows nvm root", async () => {
    const { unrelatedOauth2Path } = installWindowsNvmLayoutWithUnrelatedOauth({
      oauth2Content: FAKE_OAUTH2_CONTENT,
      unrelatedOauth2Content: "// unrelated oauth file",
    });

    clearCredentialsCache();
    const result = extractGeminiCliCredentials();

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

  type LoginGeminiCliOAuthFn = (options: {
    isRemote: boolean;
    openUrl: () => Promise<void>;
    log: (msg: string) => void;
    note: () => Promise<void>;
    prompt: () => Promise<string>;
    progress: { update: () => void; stop: () => void };
  }) => Promise<{ projectId?: string }>;

  async function runRemoteLoginWithCapturedAuthUrl(loginGeminiCliOAuth: LoginGeminiCliOAuthFn) {
    let authUrl = "";
    const result = await loginGeminiCliOAuth({
      isRemote: true,
      openUrl: async () => {},
      log: (msg) => {
        const found = msg.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^\s]+/);
        if (found?.[0]) {
          authUrl = found[0];
        }
      },
      note: async () => {},
      prompt: async () => {
        const state = new URL(authUrl).searchParams.get("state");
        return `http://localhost:8085/oauth2callback?code=oauth-code&state=${state}`;
      },
      progress: { update: () => {}, stop: () => {} },
    });
    return { result, authUrl };
  }

  async function runRemoteLoginExpectingProjectId(
    loginGeminiCliOAuth: LoginGeminiCliOAuthFn,
    projectId: string,
  ) {
    const { result } = await runRemoteLoginWithCapturedAuthUrl(loginGeminiCliOAuth);
    expect(result.projectId).toBe(projectId);
  }

  let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string>>;
  let setOAuthSettingsFsForTest: typeof import("./oauth.settings.js").setOAuthSettingsFsForTest;

  beforeAll(async () => {
    ({ setOAuthSettingsFsForTest } = await import("./oauth.settings.js"));
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
    setOAuthSettingsFsForTest({
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
    setOAuthSettingsFsForTest();
    vi.unstubAllGlobals();
  });

  it("falls back across loadCodeAssist endpoints with aligned headers and metadata", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = getRequestUrl(input);
      requests.push({ url, init });

      if (url === TOKEN_URL) {
        return responseJson({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
        });
      }
      if (url === USERINFO_URL) {
        return responseJson({ email: "lobster@openclaw.ai" });
      }
      if (url === LOAD_PROD) {
        return responseJson({ error: { message: "temporary failure" } }, 503);
      }
      if (url === LOAD_DAILY) {
        return responseJson({
          currentTier: { id: "standard-tier" },
          cloudaicompanionProject: { id: "daily-project" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { loginGeminiCliOAuth } = await import("./oauth.js");
    await runRemoteLoginExpectingProjectId(loginGeminiCliOAuth, "daily-project");
    const loadRequests = requests.filter((request) =>
      request.url.includes("v1internal:loadCodeAssist"),
    );
    expect(loadRequests.map((request) => request.url)).toEqual([LOAD_PROD, LOAD_DAILY]);

    const firstHeaders = loadRequests[0]?.init?.headers;
    expect(getHeaderValue(firstHeaders, "X-Goog-Api-Client")).toBe(
      `gl-node/${process.versions.node}`,
    );

    const clientMetadata = getHeaderValue(firstHeaders, "Client-Metadata");
    expect(clientMetadata).toBeDefined();
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
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = getRequestUrl(input);
      requests.push({ url, init });

      if (url === TOKEN_URL) {
        return responseJson({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
        });
      }
      if (url === USERINFO_URL) {
        return responseJson({ email: "lobster@openclaw.ai" });
      }
      if (url === LOAD_PROD) {
        return responseJson({
          currentTier: { id: "standard-tier" },
          cloudaicompanionProject: { id: "prod-project" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { loginGeminiCliOAuth } = await import("./oauth.js");
    const { authUrl } = await runRemoteLoginWithCapturedAuthUrl(loginGeminiCliOAuth);

    const authState = new URL(authUrl).searchParams.get("state");
    expect(authState).toBeTruthy();

    const tokenRequest = requests.find((request) => request.url === TOKEN_URL);
    expect(tokenRequest).toBeDefined();
    const codeVerifier = getFormField(tokenRequest?.init?.body, "code_verifier");
    expect(codeVerifier).toBeTruthy();
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

  it("falls back to GOOGLE_CLOUD_PROJECT when all loadCodeAssist endpoints fail", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "env-project";

    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = getRequestUrl(input);
      requests.push(url);

      if (url === TOKEN_URL) {
        return responseJson({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
        });
      }
      if (url === USERINFO_URL) {
        return responseJson({ email: "lobster@openclaw.ai" });
      }
      if ([LOAD_PROD, LOAD_DAILY, LOAD_AUTOPUSH].includes(url)) {
        return responseJson({ error: { message: "unavailable" } }, 503);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { loginGeminiCliOAuth } = await import("./oauth.js");
    await runRemoteLoginExpectingProjectId(loginGeminiCliOAuth, "env-project");
    expect(requests.filter((url) => url.includes("v1internal:loadCodeAssist"))).toHaveLength(3);
    expect(requests.some((url) => url.includes("v1internal:onboardUser"))).toBe(false);
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

    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = getRequestUrl(input);
      requests.push(url);

      if (url === TOKEN_URL) {
        return responseJson({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
        });
      }
      if (url === USERINFO_URL) {
        return responseJson({ email: "lobster@openclaw.ai" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { loginGeminiCliOAuth } = await import("./oauth.js");
    const { result } = await runRemoteLoginWithCapturedAuthUrl(loginGeminiCliOAuth);

    expect(result.projectId).toBeUndefined();
    expect(requests).toEqual([TOKEN_URL, USERINFO_URL]);
  });
});
