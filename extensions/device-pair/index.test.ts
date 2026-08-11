// Device Pair tests cover index plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";

const pluginApiMocks = vi.hoisted(() => ({
  clearDeviceBootstrapTokens: vi.fn(async () => ({ removed: 2 })),
  issueDeviceBootstrapToken: vi.fn(async () => ({
    token: "boot-token",
    expiresAtMs: Date.now() + 10 * 60_000,
  })),
  revokeDeviceBootstrapToken: vi.fn(async () => ({ removed: true })),
  renderQrPngDataUrl: vi.fn(async () => "data:image/png;base64,ZmFrZXBuZw=="),
  resolveGatewayPort: vi.fn(() => 18789),
  resolveTailscaleServeGatewayUrlsWithRunner: vi.fn(async () => []),
  resolvePreferredOpenClawTmpDir: vi.fn(() => path.join(os.tmpdir(), "openclaw-device-pair-tests")),
  writeQrPngTempFile: vi.fn(async (dataValue: string, opts: { tmpRoot: string }) => {
    const dirPath = await fs.mkdtemp(path.join(opts.tmpRoot, "device-pair-qr-"));
    const filePath = path.join(dirPath, "pair-qr.png");
    await fs.writeFile(filePath, "fakepng");
    return { filePath, dirPath, mediaLocalRoots: [dirPath] };
  }),
}));

vi.mock("./api.js", () => ({
  PAIRING_SETUP_BOOTSTRAP_PROFILE: {
    roles: ["node", "operator"],
    scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
  },
  approveDevicePairing: vi.fn(),
  clearDeviceBootstrapTokens: pluginApiMocks.clearDeviceBootstrapTokens,
  definePluginEntry: vi.fn((entry) => entry),
  issueDeviceBootstrapToken: pluginApiMocks.issueDeviceBootstrapToken,
  listDevicePairing: vi.fn(async () => ({ pending: [] })),
  renderQrPngDataUrl: pluginApiMocks.renderQrPngDataUrl,
  revokeDeviceBootstrapToken: pluginApiMocks.revokeDeviceBootstrapToken,
  resolvePreferredOpenClawTmpDir: pluginApiMocks.resolvePreferredOpenClawTmpDir,
  resolveAdvertisedLanHost: vi.fn(async () => null),
  resolveGatewayBindUrl: vi.fn(),
  resolveGatewayPort: pluginApiMocks.resolveGatewayPort,
  resolveTailnetHostWithRunner: vi.fn(),
  resolveTailscaleServeGatewayUrlsWithRunner:
    pluginApiMocks.resolveTailscaleServeGatewayUrlsWithRunner,
  runPluginCommandWithTimeout: vi.fn(),
  writeQrPngTempFile: pluginApiMocks.writeQrPngTempFile,
}));

vi.mock("./notify.js", () => ({
  armPairNotifyOnce: vi.fn(async () => false),
  formatPendingRequests: vi.fn(() => "No pending device pairing requests."),
  handleNotifyCommand: vi.fn(async () => ({ text: "notify" })),
}));

import {
  approveDevicePairing,
  listDevicePairing,
  resolveAdvertisedLanHost,
  resolveGatewayBindUrl,
  resolveTailnetHostWithRunner,
  resolveTailscaleServeGatewayUrlsWithRunner,
} from "./api.js";
import registerDevicePair from "./index.js";

type ListedPendingPairingRequest = Awaited<ReturnType<typeof listDevicePairing>>["pending"][number];
type ApproveDevicePairingResolved = Awaited<ReturnType<typeof approveDevicePairing>>;
type ApprovedPairingResult = Extract<
  NonNullable<ApproveDevicePairingResolved>,
  { status: "approved" }
>;
type RegisterPairOptions = {
  config?: OpenClawPluginApi["config"];
  runtime?: OpenClawPluginApi["runtime"];
  pluginConfig?: Record<string, unknown>;
};

const INTERNAL_PAIRING_SCOPES = ["operator.write", "operator.pairing"];
const INTERNAL_SETUP_SCOPES = [...INTERNAL_PAIRING_SCOPES, "operator.talk.secrets"];
const LIMITED_SETUP_REQUEST = {
  profile: {
    roles: ["node", "operator"],
    scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
  },
};
const FULL_SETUP_REQUEST = {
  profile: {
    roles: ["node", "operator"],
    scopes: [
      "operator.admin",
      "operator.approvals",
      "operator.read",
      "operator.talk.secrets",
      "operator.write",
    ],
    purpose: "mobile-full",
  },
};
const PAIRING_REQUIRED = "⚠️ This command requires operator.pairing.";
const TALK_SECRETS_REQUIRED =
  "⚠️ Setup code handoff includes Talk secrets and requires operator.talk.secrets.";
const SECURE_URL_REQUIRED = "Tailscale and public mobile pairing require a secure gateway URL";
// Tagged tables quote `$name`; a row toString preserves the exact existing test title via `%s`.
const exactTestTitle = (title: string) => () => title;

function createApi(
  params: RegisterPairOptions & {
    registerCommand?: (command: OpenClawPluginCommandDefinition) => void;
  } = {},
): OpenClawPluginApi {
  return createTestPluginApi({
    id: "device-pair",
    name: "device-pair",
    source: "test",
    config: params.config ?? {
      gateway: { auth: { mode: "token", token: "gateway-token" } },
    },
    pluginConfig: {
      publicUrl: "wss://gateway.example.test",
      ...params.pluginConfig,
    },
    runtime: (params.runtime ?? {}) as OpenClawPluginApi["runtime"],
    registerCommand: params.registerCommand,
  });
}

function registerPairCommand(params: RegisterPairOptions = {}): OpenClawPluginCommandDefinition {
  let command: OpenClawPluginCommandDefinition | undefined;
  registerDevicePair.register(
    createApi({
      ...params,
      registerCommand: (nextCommand) => {
        command = nextCommand;
      },
    }),
  );
  if (!command) {
    throw new Error("device-pair plugin did not register its /pair command");
  }
  return command;
}

function createCommandContext(params: Partial<PluginCommandContext> = {}): PluginCommandContext {
  return {
    channel: "webchat",
    isAuthorizedSender: true,
    commandBody: "/pair qr",
    args: "qr",
    config: {},
    requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
    ...params,
  };
}

async function runPair(context: Partial<PluginCommandContext>, options: RegisterPairOptions = {}) {
  return await registerPairCommand(options).handler(createCommandContext(context));
}

async function runDefaultSetup(
  options: RegisterPairOptions = {},
  context: Partial<PluginCommandContext> = {},
) {
  return await runPair(
    {
      channel: "webchat",
      args: "",
      commandBody: "/pair",
      gatewayClientScopes: INTERNAL_SETUP_SCOPES,
      ...context,
    },
    options,
  );
}

async function expectSetupRejected(
  options: RegisterPairOptions,
  expectedText: string,
  exact = false,
): Promise<void> {
  const result = await runDefaultSetup(options);
  expect(pluginApiMocks.issueDeviceBootstrapToken).not.toHaveBeenCalled();
  if (exact) {
    expect(result).toEqual({ text: expectedText });
  } else {
    expect(requireText(result)).toContain(expectedText);
  }
}

function requireText(result: { text?: unknown } | null | undefined): string {
  if (typeof result?.text !== "string") {
    throw new Error("pair command did not return a text response");
  }
  return result.text;
}

function requireMediaUrl(opts: { mediaUrl?: string }): string {
  if (!opts.mediaUrl) {
    throw new Error("pair command did not send a media URL");
  }
  return opts.mediaUrl;
}

async function expectPathMissing(targetPath: string): Promise<void> {
  let error: unknown;
  try {
    await fs.access(targetPath);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
}

async function expectRejectedCommand(params: {
  context: Partial<PluginCommandContext>;
  untouched: unknown;
  text: string;
}): Promise<void> {
  const result = await runPair(params.context);
  expect(params.untouched).not.toHaveBeenCalled();
  expect(result).toEqual({ text: params.text });
}

function createChannelRuntime(
  channel: string,
  sendMessage: (...args: unknown[]) => Promise<unknown>,
): OpenClawPluginApi["runtime"] {
  return {
    channel: {
      outbound: {
        loadAdapter: async (channelId: string) =>
          channelId === channel
            ? {
                sendText: async ({ to, text, ...opts }: Record<string, unknown>) =>
                  await sendMessage(to, text, opts),
                sendMedia: async ({ to, text, ...opts }: Record<string, unknown>) =>
                  await sendMessage(to, text, opts),
              }
            : undefined,
      },
    },
  } as unknown as OpenClawPluginApi["runtime"];
}

function makePendingPairingRequest(): ListedPendingPairingRequest {
  return {
    requestId: "req-1",
    deviceId: "victim-phone",
    publicKey: "victim-public-key",
    displayName: "Victim Phone",
    platform: "ios",
    ts: Date.now(),
  };
}

function makeApprovedPairingResult(): ApprovedPairingResult {
  return {
    status: "approved",
    requestId: "req-1",
    device: {
      deviceId: "victim-phone",
      publicKey: "victim-public-key",
      displayName: "Victim Phone",
      platform: "ios",
      createdAtMs: Date.now(),
      approvedAtMs: Date.now(),
    },
  };
}

function makeForbiddenPairingResult(): ApproveDevicePairingResolved {
  return {
    status: "forbidden",
    reason: "caller-missing-scope",
    scope: "operator.admin",
  };
}

function mockPendingPairingList() {
  vi.mocked(listDevicePairing).mockResolvedValueOnce({
    pending: [makePendingPairingRequest()],
    paired: [],
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  pluginApiMocks.issueDeviceBootstrapToken.mockResolvedValue({
    token: "boot-token",
    expiresAtMs: Date.now() + 10 * 60_000,
  });
  await fs.mkdir(pluginApiMocks.resolvePreferredOpenClawTmpDir(), { recursive: true });
});

afterEach(async () => {
  await fs.rm(pluginApiMocks.resolvePreferredOpenClawTmpDir(), { recursive: true, force: true });
});

afterAll(() => {
  vi.doUnmock("./api.js");
  vi.doUnmock("./notify.js");
  vi.resetModules();
});

describe("device-pair /pair qr", () => {
  it("returns an inline QR image for webchat surfaces", async () => {
    const command = registerPairCommand();
    expect(command.requiredScopes).toEqual(["operator.pairing"]);
    const result = await command.handler(
      createCommandContext({ channel: "webchat", gatewayClientScopes: ["operator.admin"] }),
    );
    const payload = result as {
      text?: string;
      mediaUrl?: string;
      channelData?: Record<string, unknown>;
      sensitiveMedia?: boolean;
    };
    const text = requireText(result);

    expect(pluginApiMocks.renderQrPngDataUrl).toHaveBeenCalledTimes(1);
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledWith(FULL_SETUP_REQUEST);
    expect(text).toContain("Scan this QR code with the OpenClaw iOS app:");
    expect(payload.mediaUrl).toBeUndefined();
    expect(payload.channelData?.openclawPairingQr).toEqual({
      setupCode: expect.any(String),
      expiresAtMs: expect.any(Number),
    });
    expect(payload.sensitiveMedia).toBe(true);
    expect(text).toContain("- Security: single-use bootstrap token");
    expect(text).toContain("**Important:** Run `/pair cleanup` after pairing finishes.");
    expect(text).toContain("If this QR code leaks, run `/pair cleanup` immediately.");
    expect(text).not.toContain("![OpenClaw pairing QR]");
  });

  it.each`
    toString                                                                                      | context                                                                 | text
    ${exactTestTitle("rejects qr setup for internal gateway callers without operator.pairing")}   | ${{ channel: "webchat", gatewayClientScopes: ["operator.write"] }}      | ${PAIRING_REQUIRED}
    ${exactTestTitle("rejects qr setup for non-gateway command surfaces without pairing scopes")} | ${{ channel: "telegram", gatewayClientScopes: undefined }}              | ${PAIRING_REQUIRED}
    ${exactTestTitle("rejects qr setup for internal callers without Talk secret scope")}          | ${{ channel: "webchat", gatewayClientScopes: INTERNAL_PAIRING_SCOPES }} | ${TALK_SECRETS_REQUIRED}
  `("%s", async ({ context, text }) => {
    await expectRejectedCommand({
      context: { ...context, args: "qr", commandBody: "/pair qr" },
      untouched: pluginApiMocks.issueDeviceBootstrapToken,
      text,
    });
  });

  it("reissues the bootstrap token if webchat QR rendering fails before falling back", async () => {
    pluginApiMocks.issueDeviceBootstrapToken
      .mockResolvedValueOnce({ token: "first-token", expiresAtMs: Date.now() + 10 * 60_000 })
      .mockResolvedValueOnce({ token: "second-token", expiresAtMs: Date.now() + 10 * 60_000 });
    pluginApiMocks.renderQrPngDataUrl.mockRejectedValueOnce(new Error("render failed"));

    const text = requireText(
      await runPair({ channel: "webchat", gatewayClientScopes: INTERNAL_SETUP_SCOPES }),
    );
    expect(pluginApiMocks.revokeDeviceBootstrapToken).toHaveBeenCalledWith({
      token: "first-token",
    });
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledTimes(2);
    expect(text).toContain(
      "QR image delivery is not available on this channel right now, so I generated a pasteable setup code instead.",
    );
    expect(text).toContain("Pairing setup code generated.");
  });

  it.each`
    toString                                                       | channel       | context                                                                                  | target                   | opts
    ${exactTestTitle("sends Telegram a real QR image attachment")} | ${"telegram"} | ${{ senderId: "123", accountId: "default", messageThreadId: 271 }}                       | ${"123"}                 | ${{ accountId: "default", threadId: 271 }}
    ${exactTestTitle("sends Discord a real QR image attachment")}  | ${"discord"}  | ${{ senderId: "123", accountId: "default" }}                                             | ${"user:123"}            | ${{ accountId: "default" }}
    ${exactTestTitle("sends Slack a real QR image attachment")}    | ${"slack"}    | ${{ senderId: "user:U123", accountId: "default", messageThreadId: "1234567890.000001" }} | ${"user:U123"}           | ${{ accountId: "default", threadId: "1234567890.000001" }}
    ${exactTestTitle("sends Signal a real QR image attachment")}   | ${"signal"}   | ${{ senderId: "signal:+15551234567", accountId: "default" }}                             | ${"signal:+15551234567"} | ${{ accountId: "default" }}
    ${exactTestTitle("sends iMessage a real QR image attachment")} | ${"imessage"} | ${{ senderId: "+15551234567", accountId: "default" }}                                    | ${"+15551234567"}        | ${{ accountId: "default" }}
    ${exactTestTitle("sends WhatsApp a real QR image attachment")} | ${"whatsapp"} | ${{ senderId: "+15551234567", accountId: "default" }}                                    | ${"+15551234567"}        | ${{ accountId: "default", verbose: false }}
  `("%s", async ({ channel, context, target, opts }) => {
    let sentPng = "";
    const sendMessage = vi.fn().mockImplementation(async (_target, _caption, sendOpts) => {
      if (sendOpts?.mediaUrl) {
        sentPng = await fs.readFile(sendOpts.mediaUrl, "utf8");
      }
      return { messageId: "1" };
    });
    const result = await runPair(
      { channel, ...context, gatewayClientScopes: INTERNAL_SETUP_SCOPES },
      { runtime: createChannelRuntime(channel, sendMessage) },
    );
    const text = requireText(result);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [actualTarget, caption, sendOpts] = sendMessage.mock.calls[0] as [
      string,
      string,
      { mediaUrl?: string; mediaLocalRoots?: string[]; accountId?: string } & Record<
        string,
        unknown
      >,
    ];
    expect(actualTarget).toBe(target);
    expect(caption).toContain("Scan this QR code with the OpenClaw iOS app:");
    expect(caption).toContain("IMPORTANT: After pairing finishes, run /pair cleanup.");
    expect(caption).toContain("If this QR code leaks, run /pair cleanup immediately.");
    const mediaUrl = requireMediaUrl(sendOpts);
    expect(mediaUrl).toMatch(/pair-qr\.png$/);
    expect(sendOpts).toEqual({
      cfg: { gateway: { auth: { mode: "token", token: "gateway-token" } } },
      mediaUrl,
      mediaLocalRoots: [path.dirname(mediaUrl)],
      ...opts,
    });
    expect(sentPng).toBe("fakepng");
    await expectPathMissing(mediaUrl);
    expect(text).toContain("QR code sent above.");
    expect(text).toContain("IMPORTANT: Run /pair cleanup after pairing finishes.");
  });

  it("reissues the bootstrap token after QR delivery failure before falling back", async () => {
    pluginApiMocks.issueDeviceBootstrapToken
      .mockResolvedValueOnce({ token: "first-token", expiresAtMs: Date.now() + 10 * 60_000 })
      .mockResolvedValueOnce({ token: "second-token", expiresAtMs: Date.now() + 10 * 60_000 });
    const sendMessage = vi.fn().mockRejectedValue(new Error("upload failed"));
    const text = requireText(
      await runPair(
        {
          channel: "discord",
          senderId: "123",
          gatewayClientScopes: INTERNAL_SETUP_SCOPES,
        },
        { runtime: createChannelRuntime("discord", sendMessage) },
      ),
    );

    expect(pluginApiMocks.revokeDeviceBootstrapToken).toHaveBeenCalledWith({
      token: "first-token",
    });
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledTimes(2);
    expect(text).toContain("Pairing setup code generated.");
    expect(text).toContain("If this code leaks or you are done, run /pair cleanup");
  });

  it("falls back to the setup code instead of ASCII when the channel cannot send media", async () => {
    const text = requireText(
      await runPair({
        channel: "msteams",
        senderId: "8:orgid:123",
        gatewayClientScopes: INTERNAL_SETUP_SCOPES,
      }),
    );
    expect(text).toContain("QR image delivery is not available on this channel");
    expect(text).toContain("Setup code:");
    expect(text).toContain("IMPORTANT: After pairing finishes, run /pair cleanup.");
    expect(text).not.toContain("```");
  });

  it.each(["toString", "constructor", "__proto__"])(
    "requires QR channel sender %s to be an own entry",
    async (channel) => {
      const loadAdapter = vi.fn(async () => undefined);
      const text = requireText(
        await runPair(
          {
            channel,
            senderId: "prototype-channel",
            gatewayClientScopes: INTERNAL_SETUP_SCOPES,
          },
          {
            runtime: {
              channel: { outbound: { loadAdapter } },
            } as unknown as OpenClawPluginApi["runtime"],
          },
        ),
      );
      expect(pluginApiMocks.writeQrPngTempFile).not.toHaveBeenCalled();
      expect(loadAdapter).not.toHaveBeenCalled();
      expect(pluginApiMocks.revokeDeviceBootstrapToken).not.toHaveBeenCalled();
      expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
      expect(text).toContain("QR image delivery is not available on this channel");
      expect(text).toContain("Setup code:");
    },
  );

  it("supports invalidating unused setup codes", async () => {
    const result = await runPair({
      channel: "telegram",
      args: "cleanup",
      commandBody: "/pair cleanup",
      gatewayClientScopes: INTERNAL_PAIRING_SCOPES,
    });
    expect(pluginApiMocks.clearDeviceBootstrapTokens).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ text: "Invalidated 2 unused setup codes." });
  });

  it.each`
    toString                                                                                    | context                                                                                                           | untouched
    ${exactTestTitle("rejects cleanup for internal gateway callers without operator.pairing")}  | ${{ channel: "webchat", args: "cleanup", commandBody: "/pair cleanup", gatewayClientScopes: ["operator.write"] }} | ${pluginApiMocks.clearDeviceBootstrapTokens}
    ${exactTestTitle("fails closed for cleanup when internal gateway scopes are absent")}       | ${{ channel: "webchat", args: "cleanup", commandBody: "/pair cleanup", gatewayClientScopes: undefined }}          | ${pluginApiMocks.clearDeviceBootstrapTokens}
    ${exactTestTitle("rejects status for non-gateway command surfaces without pairing scopes")} | ${{ channel: "telegram", args: "status", commandBody: "/pair status", gatewayClientScopes: undefined }}           | ${listDevicePairing}
  `("%s", async ({ context, untouched }) => {
    await expectRejectedCommand({ context, untouched, text: PAIRING_REQUIRED });
  });
});

describe("device-pair /pair default setup code", () => {
  it.each`
    toString                                                                                                        | context                                                                                                   | text
    ${exactTestTitle("rejects setup code issuance for internal gateway callers without operator.pairing")}          | ${{ channel: "webchat", gatewayClientScopes: ["operator.write"] }}                                        | ${PAIRING_REQUIRED}
    ${exactTestTitle("rejects unknown subcommands that fall back to setup code issuance without operator.pairing")} | ${{ channel: "webchat", args: "foo", commandBody: "/pair foo", gatewayClientScopes: ["operator.write"] }} | ${PAIRING_REQUIRED}
    ${exactTestTitle("rejects setup code issuance for internal callers without Talk secret scope")}                 | ${{ channel: "webchat", gatewayClientScopes: INTERNAL_PAIRING_SCOPES }}                                   | ${TALK_SECRETS_REQUIRED}
    ${exactTestTitle("fails closed for webchat setup code issuance when scopes are absent")}                        | ${{ channel: "webchat", gatewayClientScopes: undefined }}                                                 | ${PAIRING_REQUIRED}
    ${exactTestTitle("fails closed for non-gateway setup code issuance when scopes are absent")}                    | ${{ channel: "telegram", gatewayClientScopes: undefined }}                                                | ${PAIRING_REQUIRED}
  `("%s", async ({ context, text }) => {
    await expectRejectedCommand({
      context: { args: "", commandBody: "/pair", ...context },
      untouched: pluginApiMocks.issueDeviceBootstrapToken,
      text,
    });
  });

  it("allows command owners to issue setup codes from non-gateway command surfaces", async () => {
    const text = requireText(
      await runPair({
        channel: "telegram",
        args: "",
        commandBody: "/pair",
        gatewayClientScopes: undefined,
        senderIsOwner: true,
      }),
    );
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledWith(FULL_SETUP_REQUEST);
    expect(text).toContain("Pairing setup code generated.");
  });

  it.each`
    toString                                                                                    | options                                                                                                                                                                  | context                                        | expectedText
    ${exactTestTitle("normalizes secure bare publicUrl host ports before issuing setup codes")} | ${{ config: { gateway: { tls: { enabled: true }, auth: { mode: "token", token: "gateway-token" } } }, pluginConfig: { publicUrl: "gateway.example.test:18789/setup" } }} | ${{ gatewayClientScopes: ["operator.admin"] }} | ${"Gateway: wss://gateway.example.test:18789"}
    ${exactTestTitle("allows loopback cleartext setup urls")}                                   | ${{ pluginConfig: { publicUrl: "ws://127.0.0.1:18789" } }}                                                                                                               | ${undefined}                                   | ${"Gateway: ws://127.0.0.1:18789"}
    ${exactTestTitle("allows mdns cleartext setup urls")}                                       | ${{ pluginConfig: { publicUrl: "ws://openclaw.local:18789" } }}                                                                                                          | ${undefined}                                   | ${"Gateway: ws://openclaw.local:18789"}
  `("%s", async ({ options, context, expectedText }) => {
    const text = requireText(await runDefaultSetup(options, context));
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
    expect(text).toContain(expectedText);
  });

  it.each([
    "ws://[fc00::1]:18789",
    "ws://[fd7a:115c:a1e0::1]:18789",
    "ws://[fe80::1]:18789",
    "ws://[febf::1]:18789",
  ])("allows IPv6 ULA and link-local cleartext setup url %s", async (publicUrl) => {
    const text = requireText(await runDefaultSetup({ pluginConfig: { publicUrl } }));
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
    expect(text).toContain(`Gateway: ${publicUrl}`);
  });

  it("uses Tailscale Serve MagicDNS as a secure setup url", async () => {
    vi.mocked(resolveTailnetHostWithRunner).mockResolvedValueOnce("gateway.tailnet.ts.net");
    const text = requireText(
      await runDefaultSetup({
        config: {
          gateway: {
            tailscale: { mode: "serve" },
            auth: { mode: "token", token: "gateway-token" },
          },
        },
        pluginConfig: { publicUrl: undefined },
      }),
    );
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
    expect(text).toContain("Gateway: wss://gateway.tailnet.ts.net");
  });

  it("keeps secure setup limited for non-admin gateway callers", async () => {
    const text = requireText(await runDefaultSetup());
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledWith(LIMITED_SETUP_REQUEST);
    expect(text).toContain("Access: limited");
    expect(text).not.toContain("Plaintext ws:// was limited for safety");
  });

  it("allows private LAN cleartext setup urls", async () => {
    const text = requireText(
      await runDefaultSetup(
        { pluginConfig: { publicUrl: "ws://192.168.1.20:18789" } },
        { gatewayClientScopes: ["operator.admin"] },
      ),
    );
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledWith(LIMITED_SETUP_REQUEST);
    expect(text).toContain("Gateway: ws://192.168.1.20:18789");
    expect(text).toContain("Access: limited");
    expect(text).toContain("Plaintext ws:// was limited for safety");
  });

  it("uses the advertised LAN helper for bind-derived setup urls", async () => {
    vi.mocked(resolveAdvertisedLanHost).mockResolvedValueOnce("10.211.55.3");
    vi.mocked(resolveGatewayBindUrl).mockImplementationOnce((params) => ({
      url: `ws://${params.pickLanHost()}:18789`,
      source: "gateway.bind=lan",
    }));
    const text = requireText(
      await runDefaultSetup({
        config: {
          gateway: { bind: "lan", auth: { mode: "token", token: "gateway-token" } },
        },
        pluginConfig: { publicUrl: undefined },
      }),
    );
    expect(resolveAdvertisedLanHost).toHaveBeenCalledTimes(1);
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
    expect(text).toContain("Gateway: ws://10.211.55.3:18789");
  });

  it("includes a Tailscale Serve fallback for LAN bind-derived setup urls", async () => {
    vi.mocked(resolveAdvertisedLanHost).mockResolvedValueOnce("192.168.139.3");
    vi.mocked(resolveGatewayBindUrl).mockImplementationOnce((params) => ({
      url: `ws://${params.pickLanHost()}:18789`,
      source: "gateway.bind=lan",
    }));
    vi.mocked(resolveTailscaleServeGatewayUrlsWithRunner).mockResolvedValueOnce([
      "wss://clawmac.tail.ts.net:8443",
    ]);
    const text = requireText(
      await runDefaultSetup({
        config: {
          gateway: { bind: "lan", auth: { mode: "token", token: "gateway-token" } },
        },
        pluginConfig: { publicUrl: undefined },
      }),
    );
    expect(text).toContain("Gateway: ws://192.168.139.3:18789");
    expect(text).toContain("Fallback: wss://clawmac.tail.ts.net:8443");
  });

  it("does not advertise a loopback Serve route for a custom bind", async () => {
    vi.mocked(resolveGatewayBindUrl).mockReturnValueOnce({
      url: "ws://192.168.139.3:18789",
      source: "gateway.bind=custom",
    });
    const text = requireText(
      await runDefaultSetup({
        config: {
          gateway: {
            bind: "custom",
            customBindHost: "192.168.139.3",
            auth: { mode: "token", token: "gateway-token" },
          },
        },
        pluginConfig: { publicUrl: undefined },
      }),
    );
    expect(resolveTailscaleServeGatewayUrlsWithRunner).not.toHaveBeenCalled();
    expect(text).toContain("Gateway: ws://192.168.139.3:18789");
    expect(text).not.toContain("Fallback:");
  });

  it.each(["ws://0.0.0.0:18789", "ws://[::]:18789"])(
    "rejects unspecified cleartext setup url %s before issuing setup codes",
    async (publicUrl) => {
      await expectSetupRejected({ pluginConfig: { publicUrl } }, SECURE_URL_REQUIRED);
    },
  );

  it("rejects public cleartext setup urls before issuing setup codes", async () => {
    await expectSetupRejected(
      { pluginConfig: { publicUrl: "ws://gateway.example.test:18789" } },
      SECURE_URL_REQUIRED,
    );
  });

  it("rejects tailnet cleartext setup urls before issuing setup codes", async () => {
    vi.mocked(resolveGatewayBindUrl).mockReturnValueOnce({
      url: "ws://100.64.0.9:18789",
      source: "gateway.bind=tailnet",
    });
    await expectSetupRejected(
      {
        config: {
          gateway: {
            bind: "tailnet",
            auth: { mode: "token", token: "gateway-token" },
          },
        },
        pluginConfig: { publicUrl: undefined },
      },
      "prefer gateway.tailscale.mode=serve",
    );
  });

  it.each(["ws://[2001:db8::1]:18789", "ws://[fe7f::1]:18789", "ws://[fec0::1]:18789"])(
    "rejects non-LAN IPv6 cleartext setup url %s before issuing setup codes",
    async (publicUrl) => {
      await expectSetupRejected({ pluginConfig: { publicUrl } }, SECURE_URL_REQUIRED);
    },
  );

  it("rejects invalid bare publicUrl host ports", async () => {
    await expectSetupRejected(
      { pluginConfig: { publicUrl: "localhost:notaport" } },
      "Error: Configured publicUrl is invalid.",
      true,
    );
  });

  it("rejects invalid gateway.remote.url before falling back to bind-derived setup urls", async () => {
    await expectSetupRejected(
      {
        config: {
          gateway: {
            bind: "custom",
            customBindHost: "127.0.0.1",
            remote: { url: "http://localhost:notaport" },
            auth: { mode: "token", token: "gateway-token" },
          },
        },
        pluginConfig: { publicUrl: undefined },
      },
      "Error: Configured gateway.remote.url is invalid.",
      true,
    );
  });

  it.each([
    "http://localhost:notaport",
    "http:gateway.example.test",
    "ws:gateway.example.test",
    "http:/localhost:notaport",
    "ftp:/gateway.example.test",
    "mailto:foo@example.com",
    "ws://user:pass@gateway.example.test:18789",
  ])("rejects invalid publicUrl %s before issuing setup codes", async (publicUrl) => {
    await expectSetupRejected(
      { pluginConfig: { publicUrl } },
      "Error: Configured publicUrl is invalid.",
      true,
    );
  });
});

describe("device-pair notify pending formatting", () => {
  it("includes role and scopes for pending requests", async () => {
    const { formatPendingRequests } =
      await vi.importActual<typeof import("./notify.ts")>("./notify.ts");
    const text = formatPendingRequests([
      {
        requestId: "req-1",
        deviceId: "device-1",
        displayName: "dev one",
        platform: "ios",
        role: "operator",
        scopes: ["operator.admin", "operator.read"],
        remoteIp: "198.51.100.2",
      },
    ]);
    expect(text).toContain("Pending device pairing requests:");
    expect(text).toContain("name=dev one");
    expect(text).toContain("platform=ios");
    expect(text).toContain("role=operator");
    expect(text).toContain("scopes=operator.admin, operator.read");
    expect(text).toContain("ip=198.51.100.2");
  });

  it("falls back to roles list and no scopes when role/scopes are absent", async () => {
    const { formatPendingRequests } =
      await vi.importActual<typeof import("./notify.ts")>("./notify.ts");
    const text = formatPendingRequests([
      { requestId: "req-2", deviceId: "device-2", roles: ["node", "operator"], scopes: [] },
    ]);
    expect(text).toContain("role=node, operator");
    expect(text).toContain("scopes=none");
  });
});

describe("device-pair /pair approve", () => {
  it.each`
    toString                                                                                | context                                                                                       | pending  | approved                      | expectedCall               | expectedText
    ${exactTestTitle("rejects internal gateway callers without operator.pairing")}          | ${{ channel: "webchat", gatewayClientScopes: ["operator.write"] }}                            | ${true}  | ${undefined}                  | ${null}                    | ${PAIRING_REQUIRED}
    ${exactTestTitle("allows internal gateway callers with operator.pairing")}              | ${{ channel: "webchat", gatewayClientScopes: INTERNAL_PAIRING_SCOPES }}                       | ${true}  | ${makeApprovedPairingResult}  | ${INTERNAL_PAIRING_SCOPES} | ${"✅ Paired Victim Phone (ios)."}
    ${exactTestTitle("rejects non-gateway approvals without pairing scopes")}               | ${{ channel: "telegram", gatewayClientScopes: undefined }}                                    | ${false} | ${undefined}                  | ${null}                    | ${PAIRING_REQUIRED}
    ${exactTestTitle("allows command owners to approve from non-gateway command surfaces")} | ${{ channel: "telegram", gatewayClientScopes: undefined, senderIsOwner: true }}               | ${true}  | ${makeApprovedPairingResult}  | ${["operator.pairing"]}    | ${"✅ Paired Victim Phone (ios)."}
    ${exactTestTitle("preserves gateway caller scopes for command-owner approvals")}        | ${{ channel: "telegram", gatewayClientScopes: INTERNAL_PAIRING_SCOPES, senderIsOwner: true }} | ${true}  | ${makeApprovedPairingResult}  | ${INTERNAL_PAIRING_SCOPES} | ${"✅ Paired Victim Phone (ios)."}
    ${exactTestTitle("fails closed for approvals when internal gateway scopes are absent")} | ${{ channel: "webchat", gatewayClientScopes: undefined }}                                     | ${true}  | ${undefined}                  | ${null}                    | ${PAIRING_REQUIRED}
    ${exactTestTitle("rejects approvals that request scopes above the caller session")}     | ${{ channel: "webchat", gatewayClientScopes: INTERNAL_PAIRING_SCOPES }}                       | ${true}  | ${makeForbiddenPairingResult} | ${INTERNAL_PAIRING_SCOPES} | ${"⚠️ This command requires operator.admin to approve this pairing request."}
    ${exactTestTitle("approves from command surfaces that carry pairing scopes")}           | ${{ channel: "telegram", gatewayClientScopes: INTERNAL_PAIRING_SCOPES }}                      | ${true}  | ${makeApprovedPairingResult}  | ${INTERNAL_PAIRING_SCOPES} | ${"✅ Paired Victim Phone (ios)."}
  `("%s", async ({ context, pending, approved, expectedCall, expectedText }) => {
    if (pending) {
      mockPendingPairingList();
    }
    if (approved) {
      vi.mocked(approveDevicePairing).mockResolvedValueOnce(approved());
    }
    const result = await runPair({
      ...context,
      args: "approve latest",
      commandBody: "/pair approve latest",
    });
    if (expectedCall) {
      expect(vi.mocked(approveDevicePairing)).toHaveBeenCalledWith("req-1", {
        callerScopes: expectedCall,
      });
    } else {
      expect(vi.mocked(approveDevicePairing)).not.toHaveBeenCalled();
    }
    expect(result).toEqual({ text: expectedText });
  });
});
