import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { installGatewayTestHooks, testState, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const CONTROL_UI_E2E_TOKEN = "test-gateway-token-1234567890";

describe("Control UI assistant media e2e", () => {
  test("serves local assistant media through scoped tickets over the gateway HTTP route", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for gateway e2e media fixtures");
    }
    testState.gatewayAuth = { mode: "token", token: CONTROL_UI_E2E_TOKEN };

    const mediaDir = path.join(stateDir, "media", "control-ui-assistant-media-e2e");
    await fs.mkdir(mediaDir, { recursive: true });
    const filePath = path.join(mediaDir, "ticketed-preview.txt");
    await fs.writeFile(filePath, "ticketed control ui media\n", "utf8");

    await withGatewayServer(
      async ({ port }) => {
        const route = `http://127.0.0.1:${port}/__openclaw__/assistant-media`;
        const sourceParam = encodeURIComponent(filePath);

        const metadata = await fetch(`${route}?meta=1&source=${sourceParam}`, {
          headers: { Authorization: `Bearer ${CONTROL_UI_E2E_TOKEN}` },
        });
        expect(metadata.status).toBe(200);
        const payload = (await metadata.json()) as {
          available?: boolean;
          mediaTicket?: string;
          mediaTicketExpiresAt?: string;
        };
        expect(payload.available).toBe(true);
        expect(payload.mediaTicket).toMatch(/^v1\./);
        expect(Date.parse(payload.mediaTicketExpiresAt ?? "")).not.toBeNaN();

        const withoutTicket = await fetch(`${route}?source=${sourceParam}`);
        expect(withoutTicket.status).toBe(401);

        const ticketed = await fetch(
          `${route}?source=${sourceParam}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
        );
        expect(ticketed.status).toBe(200);
        expect(await ticketed.text()).toBe("ticketed control ui media\n");

        const otherFilePath = path.join(mediaDir, "other-preview.txt");
        await fs.writeFile(otherFilePath, "other media\n", "utf8");
        const wrongSource = await fetch(
          `${route}?source=${encodeURIComponent(otherFilePath)}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
        );
        expect(wrongSource.status).toBe(401);
      },
      {
        serverOptions: {
          auth: { mode: "token", token: CONTROL_UI_E2E_TOKEN },
          controlUiEnabled: true,
        },
      },
    );
  });
});
