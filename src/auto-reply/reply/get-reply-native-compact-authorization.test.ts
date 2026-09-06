import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadExactSessionEntry } from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { buildCommandContext } from "./commands-context.js";
import { maybeResolveNativeSlashCommandFastReply } from "./get-reply-native-slash-fast-path.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { createTypingController } from "./typing.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("native command authorization delivery", () => {
  it.each(["compact", "stop"])(
    "delivers /%s refusal through the real command router",
    async (name) => {
      const workspaceDir = tempDirs.make("openclaw-native-command-refusal-");
      const storePath = path.join(workspaceDir, "sessions.json");
      const sessionKey = "agent:main:discord:slash:denied-sender";
      const body = `/${name}`;
      const cfg = {
        commands: { text: true, allowFrom: { "*": ["approved-sender"] } },
        session: { store: storePath },
      };
      const ctx = finalizeInboundContext({
        Body: body,
        CommandBody: body,
        CommandSource: "native",
        CommandAuthorized: false,
        Provider: "discord",
        Surface: "discord",
        From: "discord:denied-sender",
        To: "slash:denied-sender",
        SenderId: "denied-sender",
        ChatType: "direct",
        SessionKey: sessionKey,
        CommandTargetSessionKey: sessionKey,
      });
      const command = buildCommandContext({
        ctx,
        cfg,
        agentId: "main",
        sessionKey,
        isGroup: false,
        triggerBodyNormalized: body,
        commandAuthorized: false,
      });
      expect(command.isAuthorizedSender).toBe(false);

      // Keep the real router: a canned handler reply would conceal compact's missing refusal.
      const result = await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
        maybeResolveNativeSlashCommandFastReply({
          ctx,
          cfg,
          agentId: "main",
          agentDir: path.join(workspaceDir, "agent"),
          agentCfg: undefined,
          commandAuthorized: false,
          defaultProvider: "openai",
          defaultModel: "gpt-5.5",
          aliasIndex: { byKey: new Map(), byAlias: new Map() },
          provider: "openai",
          model: "gpt-5.5",
          workspaceDir,
          typing: createTypingController({}),
        }),
      );
      expect(result.handled).toBe(true);
      const delivered: string[] = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          delivered.push(payload.text ?? "");
        },
      });
      if (result.handled && result.reply) {
        for (const payload of Array.isArray(result.reply) ? result.reply : [result.reply]) {
          dispatcher.sendFinalReply(payload);
        }
      }
      dispatcher.markComplete();
      const receipt = await dispatcher.waitForIdle();
      expect(delivered).toEqual(["You are not authorized to use this command."]);
      expect(receipt).toMatchObject({ counts: { final: { delivered: 1 } } });
      expect(loadExactSessionEntry({ sessionKey, storePath })).toBeUndefined();
    },
  );
});
