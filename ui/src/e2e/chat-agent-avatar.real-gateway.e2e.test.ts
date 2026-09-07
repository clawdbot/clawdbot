import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { appendTranscriptMessage } from "../../../src/config/sessions/session-accessor.js";
import { ensureGatewayOwnerProfile, setAvatar } from "../../../src/state/user-profiles.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const captureEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let instance: OpenClawTestInstance | undefined;
const suite = createControlUiE2eSuite({
  name: "Control UI agent avatar with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "control-ui-agent-avatar",
      config: { gateway: { controlUi: { enabled: true } } },
    });
    instance = owner;
    try {
      const config = JSON.parse(await readFile(owner.configPath, "utf8"));
      await owner.state.writeConfig({
        ...config,
        agents: {
          defaults: {
            workspace: owner.state.workspaceDir,
            model: { primary: "openai/gpt-5.6-luna" },
          },
          entries: {
            main: { identity: { name: "Avatar Proof", avatar: "agent-avatar.png" } },
          },
        },
      });
      const imagePath = path.join(process.cwd(), "ui/public/apple-touch-icon.png");
      await copyFile(imagePath, path.join(owner.state.workspaceDir, "agent-avatar.png"));
      // Seed the browser owner so no host account name or photo enters the capture.
      const profile = ensureGatewayOwnerProfile("Chat Proof", { env: owner.env });
      expect(
        setAvatar(profile.id, await readFile(imagePath), "image/png", { env: owner.env }).ok,
      ).toBe(true);
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      await runQaGatewayFixture(
        async () => {
          throw error;
        },
        () => owner.cleanup(),
      );
      throw error;
    }
  },
});

suite.define(() => {
  it("renders the configured workspace avatar beside a persisted assistant reply", async () => {
    if (!instance) {
      throw new Error("Gateway fixture is not running");
    }
    const owner = instance;
    const sessionKey = "agent:main:avatar-proof";
    const created = await owner.cli([
      "gateway",
      "call",
      "sessions.create",
      "--params",
      JSON.stringify({ key: sessionKey, agentId: "main", label: "Agent avatar proof" }),
      "--json",
    ]);
    expect(created.code, created.stderr).toBe(0);
    const session = JSON.parse(created.stdout) as { ok: boolean; sessionId: string };
    expect(session.ok).toBe(true);
    const reply = "My configured avatar appears beside this assistant reply.";
    for (const [role, text] of [
      ["user", "Show the configured agent identity in this conversation."],
      ["assistant", reply],
    ]) {
      await appendTranscriptMessage(
        { agentId: "main", sessionKey, sessionId: session.sessionId, env: owner.env },
        { message: { role, content: [{ type: "text", text }], timestamp: Date.now() } },
      );
    }
    const dashboard = await owner.cli(["dashboard", "--json"]);
    expect(dashboard.code, dashboard.stderr).toBe(0);
    const issued = new URL((JSON.parse(dashboard.stdout) as { browserUrl: string }).browserUrl);
    const url = new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
    url.hash = issued.hash;
    await suite.withPage(
      { locale: "en-US", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" },
      async ({ page }) => {
        expect((await page.goto(url.toString()))?.status()).toBe(200);
        await waitForControlUiGatewayReady(page);
        await page.getByText(reply, { exact: true }).waitFor();
        const avatar = page.locator("img.chat-avatar.assistant");
        const decodedWidth = async () =>
          (await avatar.count()) === 1
            ? avatar.evaluate((element) => (element as HTMLImageElement).naturalWidth)
            : 0;
        // Preserve the missing avatar on the broken revision before the regression assertion.
        if (captureEnabled) {
          await page.screenshot({ path: path.join(suite.artifactDir, "01-loaded-transcript.png") });
        }
        await expect.poll(decodedWidth).toBeGreaterThan(0);
        expect(await avatar.getAttribute("src")).toMatch(/^blob:/);
        expect(await avatar.getAttribute("alt")).toBe("Avatar Proof");
        expect(await avatar.isVisible()).toBe(true);
        expect(
          await avatar.evaluate((element) => element.closest(".chat-group")?.textContent),
        ).toContain(reply);
        if (captureEnabled) {
          await page.screenshot({ path: path.join(suite.artifactDir, "02-avatar-decoded.png") });
          await writeFile(
            path.join(suite.artifactDir, "evidence.json"),
            JSON.stringify(
              {
                sessionKey,
                configuredWorkspaceAvatar: "agent-avatar.png",
                assistantAvatarCount: await avatar.count(),
                decodedWidth: await decodedWidth(),
                visibleBesidePersistedReply: true,
                servedScripts: await page
                  .locator("script[src]")
                  .evaluateAll((scripts) =>
                    scripts.map((script) => new URL((script as HTMLScriptElement).src).pathname),
                  ),
              },
              null,
              2,
            ),
          );
        }
      },
    );
  });
});
