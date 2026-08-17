// Control UI E2E proves per-agent config writes use the canonical keyed shape.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent config save",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "agent-config-save");

const requireRecord = createRequireRecord("record", "expected-object-value");

suite.define(() => {
  it("submits keyed entries and surfaces Gateway validation failures", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const config = {
          agents: {
            entries: {
              main: {
                default: true,
                tools: { profile: "full" },
              },
            },
          },
        };
        const gateway = await installMockGateway(page, {
          assistantName: "Main agent",
          defaultAgentId: "main",
          methodResponses: {
            "agents.list": {
              agents: [{ id: "main", name: "Main agent" }],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
            "config.get": {
              config,
              sourceConfig: config,
              runtimeConfig: config,
              hash: "agent-config-hash-1",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
            "tools.catalog": {
              agentId: "main",
              profiles: [{ id: "full", label: "Full" }],
              groups: [
                {
                  id: "fs",
                  label: "Files",
                  source: "core",
                  tools: [
                    {
                      id: "read",
                      label: "read",
                      description: "Read files",
                      source: "core",
                      defaultProfiles: ["full"],
                    },
                  ],
                },
              ],
            },
            "tools.effective": {
              agentId: "main",
              profile: "full",
              groups: [],
              notices: [],
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/agents/main/tools`);
        expect(response?.status()).toBe(200);
        await gateway.waitForRequest("agents.list");
        await gateway.waitForRequest("config.get");
        await gateway.waitForRequest("tools.catalog");

        await page
          .locator(".agent-tools-group")
          .filter({ hasText: "Files" })
          .locator(".agent-tools-group__summary")
          .click();
        await gateway.deferNext("config.set");
        await page.locator("#agent-tool-read wa-switch").click();

        const request = await gateway.waitForRequest("config.set");
        const params = requireRecord(request.params);
        const raw = requireRecord(JSON.parse(String(params.raw)));
        expect(raw).toEqual({
          agents: {
            entries: {
              main: {
                default: true,
                tools: { profile: "full", deny: ["read"] },
              },
            },
          },
        });
        expect(requireRecord(raw.agents)).not.toHaveProperty("list");
        expect(params.baseHash).toBe("agent-config-hash-1");

        await gateway.rejectDeferred("config.set", {
          code: "INVALID_REQUEST",
          message: "mock validation failure",
        });
        await page.getByRole("alert").filter({ hasText: "mock validation failure" }).waitFor();

        if (captureUiProof) {
          await mkdir(proofDir, { recursive: true });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(proofDir, "01-save-error.png"),
          });
        }
      },
    );
  });
});
