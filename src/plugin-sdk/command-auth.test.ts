import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
  buildHelpMessage,
  resolveSenderCommandAuthorization,
} from "./command-auth.js";

const baseCfg = {
  commands: { useAccessGroups: true },
} as unknown as OpenClawConfig;

async function resolveAuthorization(params: {
  senderId: string;
  configuredAllowFrom?: string[];
  configuredGroupAllowFrom?: string[];
}) {
  return resolveSenderCommandAuthorization({
    cfg: baseCfg,
    rawBody: "/status",
    isGroup: true,
    dmPolicy: "pairing",
    configuredAllowFrom: params.configuredAllowFrom ?? ["dm-owner"],
    configuredGroupAllowFrom: params.configuredGroupAllowFrom ?? ["group-owner"],
    senderId: params.senderId,
    isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
    readAllowFromStore: async () => ["paired-user"],
    shouldComputeCommandAuthorized: () => true,
    resolveCommandAuthorizedFromAuthorizers: ({ useAccessGroups, authorizers }) =>
      useAccessGroups && authorizers.some((entry) => entry.configured && entry.allowed),
  });
}

describe("plugin-sdk/command-auth", () => {
  it("keeps deprecated command status builders available for compatibility", () => {
    const cfg = { commands: { config: false, debug: false } } as unknown as OpenClawConfig;

    expect(buildHelpMessage(cfg)).toContain("/commands for full list");
    expect(buildCommandsMessage(cfg)).toContain("More: /tools for available capabilities");
    expect(buildCommandsMessage(cfg)).toContain("/models - List model providers/models.");
    expect(buildCommandsMessagePaginated(cfg)).toMatchObject({
      currentPage: 1,
      totalPages: expect.any(Number),
    });
  });

  it("resolves command authorization across allowlist sources", async () => {
    const cases = [
      {
        name: "authorizes group commands from explicit group allowlist",
        senderId: "group-owner",
        expectedAuthorized: true,
        expectedSenderAllowed: true,
      },
      {
        name: "keeps pairing-store identities DM-only for group command auth",
        senderId: "paired-user",
        expectedAuthorized: false,
        expectedSenderAllowed: false,
      },
    ];

    for (const testCase of cases) {
      const result = await resolveAuthorization({ senderId: testCase.senderId });
      expect(result.commandAuthorized).toBe(testCase.expectedAuthorized);
      expect(result.senderAllowedForCommands).toBe(testCase.expectedSenderAllowed);
      expect(result.effectiveAllowFrom).toEqual(["dm-owner"]);
      expect(result.effectiveGroupAllowFrom).toEqual(["group-owner"]);
    }
  });

  it("does not grant command authorization to non-command DM input from pairing store", async () => {
    const result = await resolveSenderCommandAuthorization({
      cfg: baseCfg,
      rawBody: "hello",
      isGroup: false,
      dmPolicy: "pairing",
      configuredAllowFrom: [],
      configuredGroupAllowFrom: [],
      senderId: "paired-user",
      isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
      readAllowFromStore: async () => ["paired-user"],
      shouldComputeCommandAuthorized: (rawBody) => rawBody.startsWith("/"),
      resolveCommandAuthorizedFromAuthorizers: ({ useAccessGroups, authorizers }) =>
        useAccessGroups && authorizers.some((entry) => entry.configured && entry.allowed),
    });

    expect(result.shouldComputeAuth).toBe(false);
    expect(result.effectiveAllowFrom).toEqual(["paired-user"]);
    expect(result.senderAllowedForCommands).toBe(true);
    expect(result.commandAuthorized).toBeUndefined();
  });

  it("does not treat open DM policy as an allowlist bypass", async () => {
    const result = await resolveSenderCommandAuthorization({
      cfg: baseCfg,
      rawBody: "hello",
      isGroup: false,
      dmPolicy: "open",
      configuredAllowFrom: [],
      configuredGroupAllowFrom: [],
      senderId: "paired-user",
      isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
      readAllowFromStore: async () => ["paired-user"],
      shouldComputeCommandAuthorized: (rawBody) => rawBody.startsWith("/"),
      resolveCommandAuthorizedFromAuthorizers: ({ useAccessGroups, authorizers }) =>
        useAccessGroups && authorizers.some((entry) => entry.configured && entry.allowed),
    });

    expect(result.effectiveAllowFrom).toEqual([]);
    expect(result.senderAllowedForCommands).toBe(false);
    expect(result.commandAuthorized).toBeUndefined();
  });
});
