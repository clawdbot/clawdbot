import { describe, expect, it } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import {
  activateSlashCommands,
  deactivateSlashCommands,
  resolveSlashHandlerForToken,
} from "./slash-state.js";

function createResolvedMattermostAccount(accountId: string): ResolvedMattermostAccount {
  return {
    accountId,
    enabled: true,
    botTokenSource: "config",
    baseUrlSource: "config",
    config: {},
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
    expect(match.accountIds).toEqual(["a1"]);
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
    expect(match.accountIds?.toSorted()).toEqual(["a1", "a2"]);
  });
});
