import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";

const NATIVE_COMMAND_CASES = [
  { command: "stop", name: "stop" },
  { command: "queue collect please help", name: "queue" },
  { command: "think high", name: "think" },
] as const;

describe("Crabline Telegram native command arguments", () => {
  it("preserves full command text while restricting native names and entities to the command token", async () => {
    await withTempDir("qa-crabline-native-command-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: {
          capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
          channel: "telegram",
          channelDriver: "crabline",
          providerReadinessArtifactPath: "crabline-provider-readiness.json",
        },
        state: createQaBusState(),
      });

      try {
        for (const { command } of NATIVE_COMMAND_CASES) {
          await transport.sendNativeCommand?.({
            command,
            conversation: { id: "alice", kind: "direct" },
            senderId: "alice",
            senderName: "Alice",
          });
        }

        expect(transport.state.getSnapshot().messages).toMatchObject(
          NATIVE_COMMAND_CASES.map(({ command, name }) => ({
            text: `/${command}`,
            nativeCommand: { name },
          })),
        );

        const telegram = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" }).channels
          ?.telegram as { apiRoot?: string; botToken?: string } | undefined;
        if (!telegram?.apiRoot || !telegram.botToken) {
          throw new Error("Crabline Telegram API root and bot token are required");
        }
        const response = await fetch(`${telegram.apiRoot}/bot${telegram.botToken}/getUpdates`);
        await expect(response.json()).resolves.toMatchObject({
          result: NATIVE_COMMAND_CASES.map(({ command, name }) => ({
            message: {
              entities: [{ length: name.length + 1, offset: 0, type: "bot_command" }],
              text: `/${command}`,
            },
          })),
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });
});
