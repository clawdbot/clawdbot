import { describe, expect, it } from "vitest";
import { NODE_AGENT_CLI_CLAUDE_RUN_COMMANDS } from "../../infra/node-commands.js";
import { buildNodeCommandRejectionHint } from "./node-command-rejection-hint.js";

describe("buildNodeCommandRejectionHint", () => {
  it.each(NODE_AGENT_CLI_CLAUDE_RUN_COMMANDS)(
    "reports an equivalent Claude run deny when %s is rejected",
    (deniedCommand) => {
      const rejectedCommand = NODE_AGENT_CLI_CLAUDE_RUN_COMMANDS.find(
        (command) => command !== deniedCommand,
      );

      expect(
        buildNodeCommandRejectionHint(
          "command not allowlisted",
          rejectedCommand ?? deniedCommand,
          { platform: "linux" },
          { gateway: { nodes: { commands: { deny: [deniedCommand] } } } },
        ),
      ).toContain("is blocked by gateway.nodes.commands.deny");
    },
  );
});
