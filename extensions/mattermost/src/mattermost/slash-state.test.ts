import { describe, expect, it } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import type { MattermostRegisteredCommand } from "./slash-commands.js";
import {
  activateSlashCommands,
  deactivateSlashCommands,
  resolveSlashHandlerForCommand,
  resolveSlashHandlerForToken,
} from "./slash-state.js";

function createResolvedMattermostAccount(accountId: string): ResolvedMattermostAccount {
  return {
    accountId,
    enabled: true,
    botTokenSource: "config",
    baseUrlSource: "config",
    streamingMode: "partial",
    config: {},
  };
}

function createRegisteredCommand(params?: {
  id?: string;
  teamId?: string;
  trigger?: string;
}): MattermostRegisteredCommand {
  return {
    id: params?.id ?? "cmd-1",
    teamId: params?.teamId ?? "team-1",
    trigger: params?.trigger ?? "oc_status",
    token: "token-1",
    url: "https://gateway.example.com/slash",
    managed: false,
  };
}

const slashApi = {
  cfg: {},
  runtime: {
    log: () => {},
    error: () => {},
    exit: () => {},
  },
} satisfies {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
};

describe("slash-state token routing", () => {
  it("returns single match when token belongs to one account", () => {
    deactivateSlashCommands();
    activateSlashCommands({
      account: createResolvedMattermostAccount("a1"),
      commandTokens: ["tok-a"],
      registeredCommands: [],
      api: slashApi,
    });

    const match = resolveSlashHandlerForToken("tok-a");
    expect(match.kind).toBe("single");
    if (match.kind !== "single") {
      throw new Error("expected single match");
    }
    expect(match.source).toBe("token");
    expect(match.accountIds).toEqual(["a1"]);
    expect(typeof match.handler).toBe("function");
  });

  it("returns ambiguous when same token exists in multiple accounts", () => {
    deactivateSlashCommands();
    activateSlashCommands({
      account: createResolvedMattermostAccount("a1"),
      commandTokens: ["tok-shared"],
      registeredCommands: [],
      api: slashApi,
    });
    activateSlashCommands({
      account: createResolvedMattermostAccount("a2"),
      commandTokens: ["tok-shared"],
      registeredCommands: [],
      api: slashApi,
    });

    const match = resolveSlashHandlerForToken("tok-shared");
    expect(match.kind).toBe("ambiguous");
    if (match.kind !== "ambiguous") {
      throw new Error("expected ambiguous match");
    }
    expect(match.source).toBe("token");
    expect(match.accountIds.toSorted()).toEqual(["a1", "a2"]);
  });

  it("routes by registered team and command when token lookup misses", () => {
    deactivateSlashCommands();
    activateSlashCommands({
      account: createResolvedMattermostAccount("a1"),
      commandTokens: ["old-token"],
      registeredCommands: [createRegisteredCommand()],
      api: slashApi,
    });

    const match = resolveSlashHandlerForCommand({
      teamId: "team-1",
      command: "/oc_status",
    });

    expect(match.kind).toBe("single");
    if (match.kind !== "single") {
      throw new Error("expected single match");
    }
    expect(match.source).toBe("command");
    expect(match.accountIds).toEqual(["a1"]);
    expect(typeof match.handler).toBe("function");
  });

  it("returns ambiguous when registered team and command match multiple accounts", () => {
    deactivateSlashCommands();
    activateSlashCommands({
      account: createResolvedMattermostAccount("a1"),
      commandTokens: ["tok-a"],
      registeredCommands: [createRegisteredCommand({ id: "cmd-a" })],
      api: slashApi,
    });
    activateSlashCommands({
      account: createResolvedMattermostAccount("a2"),
      commandTokens: ["tok-b"],
      registeredCommands: [createRegisteredCommand({ id: "cmd-b" })],
      api: slashApi,
    });

    const match = resolveSlashHandlerForCommand({
      teamId: "team-1",
      command: "/oc_status",
    });

    expect(match.kind).toBe("ambiguous");
    if (match.kind !== "ambiguous") {
      throw new Error("expected ambiguous match");
    }
    expect(match.source).toBe("command");
    expect(match.accountIds.toSorted()).toEqual(["a1", "a2"]);
  });
});
