// Imessage tests cover the chat-action service contract: a parser-default
// "auto" service must defer to the account's configured service before the
// deliverability verdict, or configured SMS accounts lose typing/read actions
// on bare short codes.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedIMessageAccount } from "./accounts.js";
import { markIMessageChatRead, sendIMessageTyping } from "./chat.js";
import type { IMessageRpcClient } from "./client.js";

const accountWithService = (service?: string): ResolvedIMessageAccount =>
  ({
    accountId: "default",
    enabled: true,
    configured: true,
    config: service ? { service } : {},
  }) as ResolvedIMessageAccount;

// Chat actions only exercise `request`; the RPC client's lifecycle surface is
// irrelevant here. The mock is held in a standalone variable so assertions
// never reference the method through the typed client (unbound-method).
const chatClient = (): { client: IMessageRpcClient; request: ReturnType<typeof vi.fn> } => {
  const request = vi.fn(async () => ({ ok: true }));
  return { client: { request, stop: vi.fn() } as unknown as IMessageRpcClient, request };
};

const chatOpts = (client: ReturnType<typeof chatClient>["client"], service?: string) => ({
  cfg: { channels: { imessage: {} } } as OpenClawConfig,
  account: accountWithService(service),
  client,
});

describe("imessage chat actions", () => {
  it("lets a configured SMS account reach bare short codes for typing", async () => {
    const { client, request } = chatClient();
    await sendIMessageTyping("12345", true, chatOpts(client, "sms"));
    expect(request).toHaveBeenCalledWith(
      "typing",
      expect.objectContaining({ to: "12345", service: "sms", typing: true }),
      expect.anything(),
    );
  });

  it("lets a configured SMS account reach bare short codes for read receipts", async () => {
    const { client, request } = chatClient();
    await markIMessageChatRead("12345", chatOpts(client, "sms"));
    // Read RPCs carry no service field; the resolved service only gates the
    // deliverability verdict.
    expect(request).toHaveBeenCalledWith(
      "read",
      expect.objectContaining({ to: "12345" }),
      expect.anything(),
    );
  });

  it("still rejects bare short codes when no service resolves to sms", async () => {
    const { client, request } = chatClient();
    await expect(sendIMessageTyping("12345", true, chatOpts(client))).rejects.toThrow(
      /not a deliverable handle/,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("still rejects bare short codes on the default imessage service", async () => {
    const { client, request } = chatClient();
    await expect(markIMessageChatRead("12345", chatOpts(client, "imessage"))).rejects.toThrow(
      /not a deliverable handle/,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps explicit sms short codes deliverable", async () => {
    const { client, request } = chatClient();
    await sendIMessageTyping("sms:12345", true, chatOpts(client));
    expect(request).toHaveBeenCalledWith(
      "typing",
      expect.objectContaining({ to: "12345", service: "sms" }),
      expect.anything(),
    );
  });

  it("lets an explicit auto short code reach Messages selection", async () => {
    // `auto:<contact>` is the documented form that lets Messages choose
    // iMessage or SMS; the verdict must not reject it before delivery.
    const { client, request } = chatClient();
    await sendIMessageTyping("auto:12345", true, chatOpts(client));
    expect(request).toHaveBeenCalledWith(
      "typing",
      expect.objectContaining({ to: "12345", service: "auto" }),
      expect.anything(),
    );
  });
});
