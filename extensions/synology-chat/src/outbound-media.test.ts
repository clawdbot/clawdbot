// Synology Chat tests cover guarded outbound attachment staging and same-route capability serving.
import fs from "node:fs";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import type { loadWebMedia as loadWebMediaType } from "openclaw/plugin-sdk/web-media";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSynologyHostedMediaRoute } from "./hosted-media-route.js";
import {
  prepareSynologyHostedMedia,
  tryHandleSynologyHostedMediaRequest,
} from "./outbound-media.js";
import { setSynologyRuntime } from "./runtime.js";
import { makeReq, makeRes } from "./test-http-utils.js";
import type { ResolvedSynologyChatAccount } from "./types.js";

const loadWebMediaMock = vi.hoisted(() => vi.fn<typeof loadWebMediaType>());

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: loadWebMediaMock,
}));

const testStateEnv: NodeJS.ProcessEnv = {
  ...process.env,
  OPENCLAW_STATE_DIR: fs.mkdtempSync(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-synology-media-"),
  ),
};

function createAccount(overrides: Partial<ResolvedSynologyChatAccount> = {}) {
  return {
    accountId: "default",
    enabled: true,
    token: "token",
    incomingUrl: "https://nas.example.com/incoming",
    webhookUrl: "https://gateway.example.com/public/synology?proxy-token=keep",
    nasHost: "nas.example.com",
    webhookPath: "/internal/synology",
    webhookPathSource: "explicit" as const,
    dangerouslyAllowNameMatching: false,
    dangerouslyAllowInheritedWebhookPath: false,
    dmPolicy: "allowlist" as const,
    allowedUserIds: ["42"],
    rateLimitPerMinute: 30,
    botName: "OpenClaw",
    allowInsecureSsl: false,
    ...overrides,
  } satisfies ResolvedSynologyChatAccount;
}

function installRuntime() {
  const openKeyedStore = vi.fn((options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests("synology-chat", { ...options, env: testStateEnv }),
  );
  setSynologyRuntime({ state: { openKeyedStore } } as unknown as PluginRuntime);
  return openKeyedStore;
}

function internalCapabilityUrl(publicUrl: string, pathName = "/internal/synology"): string {
  return `${pathName}${new URL(publicUrl).search}`;
}

describe("Synology Chat hosted outbound media", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    installRuntime();
    loadWebMediaMock.mockReset();
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("frozen-image-bytes"),
      kind: "image",
      contentType: "image/png",
      fileName: "floor-plan.png",
    });
    vi.useRealTimers();
  });

  it("requires an exact public HTTPS callback without credentials or fragments", () => {
    const credentialedUrl = new URL("https://gateway.example.com/webhook");
    credentialedUrl.username = "fixture-user";
    credentialedUrl.password = "fixture-password";
    expect(() => resolveSynologyHostedMediaRoute(createAccount({ webhookUrl: "" }))).toThrow(
      "attachments require webhookUrl",
    );
    expect(() =>
      resolveSynologyHostedMediaRoute(
        createAccount({ webhookUrl: "http://gateway.example.com/webhook" }),
      ),
    ).toThrow("must be an absolute HTTPS URL");
    expect(() =>
      resolveSynologyHostedMediaRoute(createAccount({ webhookUrl: credentialedUrl.toString() })),
    ).toThrow("must be an absolute HTTPS URL");
  });

  it("freezes source bytes and serves repeat GET/HEAD requests on the internal route", async () => {
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/floor-plan.png",
    });
    expect(prepared.url).toMatch(
      /^https:\/\/gateway\.example\.com\/public\/synology\?proxy-token=keep&__openclaw_synology_media_token_[a-f0-9]{24}=/u,
    );
    expect(prepared.url).not.toContain("files.example.com");
    expect(loadWebMediaMock).toHaveBeenCalledTimes(1);

    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("changed-source-bytes"),
      kind: "image",
      contentType: "image/png",
      fileName: "changed.png",
    });
    const requestUrl = internalCapabilityUrl(prepared.url);
    const head = makeRes();
    await expect(
      tryHandleSynologyHostedMediaRequest(makeReq("HEAD", "", { url: requestUrl }), head, account),
    ).resolves.toBe(true);
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-disposition"]).toContain("attachment");
    expect(head.headers["content-disposition"]).toContain("floor-plan.png");
    expect(head.headers["x-content-type-options"]).toBe("nosniff");
    expect(head.headers["cache-control"]).toBe("no-store");

    for (let index = 0; index < 2; index += 1) {
      const get = makeRes();
      await tryHandleSynologyHostedMediaRequest(
        makeReq("GET", "", { url: requestUrl }),
        get,
        account,
      );
      expect(get.statusCode).toBe(200);
      expect(Buffer.from(get.body).toString("utf8")).toBe("frozen-image-bytes");
    }
    expect(loadWebMediaMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed for wrong tokens, accounts, routes, and unsupported methods", async () => {
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/report.pdf",
    });
    const capability = new URL(prepared.url);
    const tokenKey = [...capability.searchParams.keys()].find((key) =>
      key.startsWith("__openclaw_synology_media_token_"),
    );
    if (!tokenKey) {
      throw new Error("expected Synology hosted media token");
    }

    const wrongToken = new URLSearchParams(capability.search);
    wrongToken.set(tokenKey, "wrong");
    const unauthorized = makeRes();
    await tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: `/internal/synology?${wrongToken.toString()}` }),
      unauthorized,
      account,
    );
    expect(unauthorized.statusCode).toBe(401);

    const crossAccount = makeRes();
    await tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: internalCapabilityUrl(prepared.url) }),
      crossAccount,
      createAccount({ accountId: "other" }),
    );
    expect(crossAccount.statusCode).toBe(404);

    const crossRoute = makeRes();
    await tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: internalCapabilityUrl(prepared.url, "/other") }),
      crossRoute,
      account,
    );
    expect(crossRoute.statusCode).toBe(404);

    const method = makeRes();
    await tryHandleSynologyHostedMediaRequest(
      makeReq("POST", "", { url: internalCapabilityUrl(prepared.url) }),
      method,
      account,
    );
    expect(method.statusCode).toBe(405);
  });

  it("rejects active content and leaves no live capability", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("<svg onload=alert(1)></svg>"),
      kind: "image",
      contentType: "image/svg+xml",
      fileName: "active.svg",
    });
    await expect(
      prepareSynologyHostedMedia({
        account: createAccount(),
        mediaUrl: "https://files.example.com/active.svg",
      }),
    ).rejects.toThrow("do not support active content type");
  });

  it("sanitizes response filenames before constructing headers", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("pdf"),
      kind: undefined,
      contentType: "application/pdf",
      fileName: '../quarter\r\nX-Evil: yes/"plan".pdf',
    });
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/report.pdf",
    });
    const response = makeRes();
    await tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: internalCapabilityUrl(prepared.url) }),
      response,
      account,
    );
    const disposition = response.headers["content-disposition"] ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).not.toMatch(/[\r\n]/u);
    expect(disposition).not.toContain("../");
  });

  it("expires capabilities without falling back to the source URL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    installRuntime();
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/report.pdf",
    });
    vi.setSystemTime(1_700_000_000_000 + 10 * 60_000 + 1);
    const response = makeRes();
    await tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: internalCapabilityUrl(prepared.url) }),
      response,
      account,
    );
    expect(response.statusCode).toBe(404);
    expect(loadWebMediaMock).toHaveBeenCalledTimes(1);
  });
});
