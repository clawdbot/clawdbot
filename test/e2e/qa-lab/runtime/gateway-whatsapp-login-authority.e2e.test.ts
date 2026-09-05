// QA Lab proof for WhatsApp login authorization through the real Gateway plugin path.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_SCOPE, WRITE_SCOPE } from "../../../../src/gateway/operator-scopes.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";

type ToolsInvokeResult = {
  ok: boolean;
  toolName: string;
  output?: unknown;
  source?: string;
  error?: { code?: string; message?: string };
};

let instance: OpenClawTestInstance | undefined;

afterEach(async () => {
  await instance?.cleanup();
  instance = undefined;
});

describe("Gateway WhatsApp login authority", () => {
  it(
    "hides credential relinking from non-owners and preserves the owner wait flow",
    { timeout: 120_000 },
    async () => {
      instance = await createOpenClawTestInstance({
        name: "qa-whatsapp-login-authority",
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "dist", "extensions"),
        },
        config: {
          plugins: {
            enabled: true,
            allow: ["whatsapp"],
            entries: { whatsapp: { enabled: true } },
          },
          agents: {
            list: [
              {
                id: "main",
                default: true,
                tools: { allow: ["whatsapp_login"] },
              },
            ],
          },
          gateway: { tools: { allow: ["whatsapp_login"] } },
        },
      });

      const credsPath = path.join(
        instance.stateDir,
        "credentials",
        "whatsapp",
        "default",
        "creds.json",
      );
      const sentinel = `${JSON.stringify({ registered: true, proof: "preserve" })}\n`;
      await fs.mkdir(path.dirname(credsPath), { recursive: true });
      await fs.writeFile(credsPath, sentinel, "utf8");
      await instance.startGateway();

      const nonOwner = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        scopes: [WRITE_SCOPE],
        clientDisplayName: "whatsapp-login-non-owner",
        deviceFamily: "whatsapp-login-non-owner",
        timeoutMs: 30_000,
      });
      const owner = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        scopes: [ADMIN_SCOPE, WRITE_SCOPE],
        clientDisplayName: "whatsapp-login-owner",
        deviceFamily: "whatsapp-login-owner",
        timeoutMs: 30_000,
      });

      try {
        const denied = await nonOwner.request<ToolsInvokeResult>("tools.invoke", {
          name: "whatsapp_login",
          args: { action: "start", force: true, timeoutMs: 1 },
          sessionKey: "main",
        });
        expect(denied).toEqual({
          ok: false,
          toolName: "whatsapp_login",
          error: {
            code: "not_found",
            message: "Tool not available: whatsapp_login",
          },
        });
        await expect(fs.readFile(credsPath, "utf8")).resolves.toBe(sentinel);

        const allowed = await owner.request<ToolsInvokeResult>("tools.invoke", {
          name: "whatsapp_login",
          args: { action: "wait", timeoutMs: 1 },
          sessionKey: "main",
        });
        expect(allowed).toMatchObject({
          ok: true,
          toolName: "whatsapp_login",
          source: "plugin",
          output: {
            content: [{ type: "text", text: "No active WhatsApp login in progress." }],
            details: { connected: false },
          },
        });

        console.log(
          `[qa-whatsapp-login-authority] ${JSON.stringify({
            nonOwner: "tool-hidden",
            credentialSentinel: "preserved",
            ownerWait: "allowed",
            source: allowed.source,
          })}`,
        );
      } finally {
        await disconnectGatewayClient(owner);
        await disconnectGatewayClient(nonOwner);
      }
    },
  );
});
