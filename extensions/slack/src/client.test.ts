import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@slack/web-api", () => {
  const WebClient = vi.fn(function WebClientMock(
    this: Record<string, unknown>,
    token: string,
    options?: Record<string, unknown>,
  ) {
    this.token = token;
    this.options = options;
  });
  return { WebClient };
});

let createSlackWebClient: typeof import("./client.js").createSlackWebClient;
let createSlackWriteClient: typeof import("./client.js").createSlackWriteClient;
let createSlackTokenCacheKey: typeof import("./client.js").createSlackTokenCacheKey;
let getSlackWriteClient: typeof import("./client.js").getSlackWriteClient;
let clearSlackWriteClientCacheForTest: typeof import("./client.js").clearSlackWriteClientCacheForTest;
let resolveSlackWebClientOptions: typeof import("./client.js").resolveSlackWebClientOptions;
let resolveSlackWriteClientOptions: typeof import("./client.js").resolveSlackWriteClientOptions;
let SLACK_DEFAULT_RETRY_OPTIONS: typeof import("./client.js").SLACK_DEFAULT_RETRY_OPTIONS;
let SLACK_WRITE_RETRY_OPTIONS: typeof import("./client.js").SLACK_WRITE_RETRY_OPTIONS;
let WebClient: ReturnType<typeof vi.fn>;

const PROXY_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "OPENCLAW_PROXY_ACTIVE",
  "OPENCLAW_PROXY_CA_FILE",
] as const;
const originalEnv = { ...process.env };
const tempDirs: string[] = [];

function clearProxyEnvForTest() {
  for (const key of PROXY_KEYS) {
    delete process.env[key];
  }
}

function restoreProxyEnvForTest() {
  for (const key of PROXY_KEYS) {
    if (originalEnv[key] !== undefined) {
      process.env[key] = originalEnv[key];
    } else {
      delete process.env[key];
    }
  }
}

function requireAgent<T extends { agent?: unknown }>(options: T): NonNullable<T["agent"]> {
  if (!options.agent) {
    throw new Error("expected proxy agent");
  }
  return options.agent as NonNullable<T["agent"]>;
}

function writeTempCa(contents: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-proxy-ca-"));
  tempDirs.push(dir);
  const caFile = path.join(dir, "proxy-ca.pem");
  writeFileSync(caFile, contents, "utf8");
  return caFile;
}

beforeAll(async () => {
  const slackWebApi = await import("@slack/web-api");
  ({
    createSlackWebClient,
    createSlackWriteClient,
    createSlackTokenCacheKey,
    getSlackWriteClient,
    clearSlackWriteClientCacheForTest,
    resolveSlackWebClientOptions,
    resolveSlackWriteClientOptions,
    SLACK_DEFAULT_RETRY_OPTIONS,
    SLACK_WRITE_RETRY_OPTIONS,
  } = await import("./client.js"));
  WebClient = slackWebApi.WebClient as unknown as ReturnType<typeof vi.fn>;
});

beforeEach(() => {
  WebClient.mockClear();
  clearSlackWriteClientCacheForTest();
});

describe("slack web client config", () => {
  it("applies the default retry config when none is provided", () => {
    const options = resolveSlackWebClientOptions();

    expect(options.retryConfig).toEqual(SLACK_DEFAULT_RETRY_OPTIONS);
  });

  it("respects explicit retry config overrides", () => {
    const customRetry = { retries: 0 };
    const options = resolveSlackWebClientOptions({ retryConfig: customRetry });

    expect(options.retryConfig).toBe(customRetry);
  });

  it("passes merged options into WebClient", () => {
    const customAgent = {} as never;

    createSlackWebClient("xoxb-test", { timeout: 1234, agent: customAgent });

    expect(WebClient).toHaveBeenCalledWith("xoxb-test", {
      agent: customAgent,
      retryConfig: SLACK_DEFAULT_RETRY_OPTIONS,
      timeout: 1234,
    });
  });

  it("applies the default retry config when constructing a client without proxy env", () => {
    clearProxyEnvForTest();
    try {
      createSlackWebClient("xoxb-test", { timeout: 1234 });

      expect(WebClient).toHaveBeenCalledWith("xoxb-test", {
        agent: undefined,
        retryConfig: SLACK_DEFAULT_RETRY_OPTIONS,
        timeout: 1234,
      });
    } finally {
      restoreProxyEnvForTest();
    }
  });

  it("applies the write retry config when none is provided", () => {
    const options = resolveSlackWriteClientOptions();

    expect(options.retryConfig).toEqual(SLACK_WRITE_RETRY_OPTIONS);
  });

  it("serializes write client requests by default", () => {
    const options = resolveSlackWriteClientOptions();

    expect(options.maxRequestConcurrency).toBe(1);
  });

  it("respects explicit write client concurrency overrides", () => {
    const options = resolveSlackWriteClientOptions({ maxRequestConcurrency: 5 });

    expect(options.maxRequestConcurrency).toBe(5);
  });

  it("passes no-retry config into the write client by default", () => {
    const customAgent = {} as never;

    createSlackWriteClient("xoxb-test", { timeout: 4321, agent: customAgent });

    expect(WebClient).toHaveBeenCalledWith("xoxb-test", {
      agent: customAgent,
      maxRequestConcurrency: 1,
      retryConfig: SLACK_WRITE_RETRY_OPTIONS,
      timeout: 4321,
    });
  });

  it("reuses default write clients per token", () => {
    clearProxyEnvForTest();
    try {
      const first = getSlackWriteClient("xoxb-test");
      const second = getSlackWriteClient("xoxb-test");

      expect(second).toBe(first);
      expect(WebClient).toHaveBeenCalledTimes(1);
      expect(WebClient).toHaveBeenCalledWith("xoxb-test", {
        agent: undefined,
        maxRequestConcurrency: 1,
        retryConfig: SLACK_WRITE_RETRY_OPTIONS,
      });
    } finally {
      restoreProxyEnvForTest();
    }
  });

  it("keeps default write clients separated by token", () => {
    const first = getSlackWriteClient("xoxb-one");
    const second = getSlackWriteClient("xoxb-two");

    expect(second).not.toBe(first);
    expect(WebClient).toHaveBeenCalledTimes(2);
  });

  it("builds stable non-secret token cache keys", () => {
    const token = "xoxb-sensitive-token";
    const first = createSlackTokenCacheKey(token);
    const second = createSlackTokenCacheKey(token);

    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:/);
    expect(first).not.toContain(token);
    expect(createSlackTokenCacheKey("xoxb-other-token")).not.toBe(first);
  });
});

describe("slack proxy agent", () => {
  beforeEach(() => {
    clearProxyEnvForTest();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    restoreProxyEnvForTest();
  });

  it("sets agent from HTTPS_PROXY env var", () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:3128";
    const options = resolveSlackWebClientOptions();
    const agent = requireAgent(options);

    expect(agent.constructor.name).toBe("HttpsProxyAgent");
  });

  it("adds managed proxy CA trust to Slack env proxy agents", () => {
    const caFile = writeTempCa("slack-managed-proxy-ca");
    process.env.HTTPS_PROXY = "https://proxy.example.com:8443";
    process.env.OPENCLAW_PROXY_ACTIVE = "1";
    process.env.OPENCLAW_PROXY_CA_FILE = caFile;

    const options = resolveSlackWebClientOptions();
    const agent = requireAgent(options) as { connectOpts?: { ca?: unknown } };

    expect(agent.connectOpts?.ca).toBe("slack-managed-proxy-ca");
  });

  it("falls back to HTTP_PROXY when HTTPS_PROXY is not set", () => {
    process.env.HTTP_PROXY = "http://proxy.example.com:3128";
    const options = resolveSlackWebClientOptions();

    expect(requireAgent(options).constructor.name).toBe("HttpsProxyAgent");
  });

  it("does not set agent when no proxy env var is configured", () => {
    const options = resolveSlackWebClientOptions();

    expect(options.agent).toBeUndefined();
  });

  it("does not override an explicitly provided agent", () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:3128";
    const customAgent = {} as never;
    const options = resolveSlackWebClientOptions({ agent: customAgent });

    expect(options.agent).toBe(customAgent);
  });

  it("prefers lowercase https_proxy over uppercase", () => {
    process.env.https_proxy = "http://lower.example.com:3128";
    process.env.HTTPS_PROXY = "http://upper.example.com:3128";
    const options = resolveSlackWebClientOptions();
    const agent = requireAgent(options);

    // HttpsProxyAgent stores the proxy URL — verify it picked the lower-case one
    expect((agent as unknown as { proxy: { href: string } }).proxy.href).toContain(
      "lower.example.com",
    );
  });

  it("treats empty lowercase https_proxy as authoritative over uppercase", () => {
    process.env.https_proxy = "";
    process.env.HTTPS_PROXY = "http://upper.example.com:3128";
    const options = resolveSlackWebClientOptions();

    expect(options.agent).toBeUndefined();
  });

  it("also applies proxy agent to write client options", () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:3128";
    const options = resolveSlackWriteClientOptions();
    const agent = requireAgent(options);

    expect(agent.constructor.name).toBe("HttpsProxyAgent");
  });

  it("respects NO_PROXY excluding slack.com", () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:3128";
    process.env.NO_PROXY = "localhost,slack.com,.internal.corp";
    const options = resolveSlackWebClientOptions();

    expect(options.agent).toBeUndefined();
  });

  it("respects no_proxy (lowercase) excluding .slack.com", () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:3128";
    process.env.no_proxy = ".slack.com";
    const options = resolveSlackWebClientOptions();

    expect(options.agent).toBeUndefined();
  });

  it("respects space-separated no_proxy entries", () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:3128";
    process.env.no_proxy = "localhost *.slack.com";
    const options = resolveSlackWebClientOptions();

    expect(options.agent).toBeUndefined();
  });

  it("respects NO_PROXY wildcard", () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:3128";
    process.env.NO_PROXY = "*";
    const options = resolveSlackWebClientOptions();

    expect(options.agent).toBeUndefined();
  });

  it("does not skip proxy when NO_PROXY excludes unrelated hosts", () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:3128";
    process.env.NO_PROXY = "localhost,.internal.corp";
    const options = resolveSlackWebClientOptions();

    expect(requireAgent(options).constructor.name).toBe("HttpsProxyAgent");
  });

  it("degrades gracefully on malformed proxy URL", () => {
    process.env.HTTPS_PROXY = "not-a-valid-url://:::bad";
    const options = resolveSlackWebClientOptions();

    // Should not throw; falls back to no agent
    expect(options.agent).toBeUndefined();
  });
});
