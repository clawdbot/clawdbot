import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";

describe("Crabline outbound target correlation", () => {
  it("preserves Telegram group identity for topic replies", async () => {
    await withTempDir("qa-crabline-targets-", async (outputDir) => {
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
        const groupId = "-1001234567890";
        const threadId = "928";
        await transport.state.addInboundMessage({
          conversation: { id: groupId, kind: "group" },
          senderId: "100001",
          text: "Telegram topic seed",
          threadId,
        });
        const telegram = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" }).channels
          ?.telegram as { apiRoot?: string; botToken?: string } | undefined;
        const { response, release } = await fetchWithSsrFGuard({
          url: `${telegram?.apiRoot}/bot${telegram?.botToken}/sendMessage`,
          init: {
            body: JSON.stringify({
              chat_id: groupId,
              message_thread_id: threadId,
              text: "assistant via fake telegram topic",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
          policy: { allowPrivateNetwork: true },
          auditContext: "qa-lab-crabline-transport-topic-test",
        });
        await release();
        expect(response.ok).toBe(true);

        await expect(
          transport.waitForOutbound({
            conversation: { id: groupId, kind: "group" },
            textIncludes: "assistant via fake telegram topic",
            threadId,
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: { id: groupId, kind: "group" },
          direction: "outbound",
          text: "assistant via fake telegram topic",
          threadId,
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });
});
