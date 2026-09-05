import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI usage sessions owner attribution",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.resolve(
  process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim() || ".artifacts/control-ui-e2e",
  "usage-sessions-owner-attribution",
);
const viewport = { height: 900, width: 1_440 };

const PROOF_SESSION_ID = "tg-dm-owner-attribution-proof";
const PROOF_STORE_KEY = "agent:main:telegram:dm";
const PROOF_LABEL = "Telegram DM";

async function capture(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

suite.define(() => {
  it.for([false, true])(
    "keeps same-id owners separate with an empty current session: %s",
    async (resetCurrentSession, context) => {
      let fixture: OpenClawTestState | undefined;
      let gateway: Promise<GatewayServer> | undefined;
      await suite.runScenario(context, {
        retainedState: () => fixture?.root,
        close: async () => {
          const server = await gateway;
          await server?.close({ reason: "usage sessions owner attribution e2e cleanup" });
        },
        release: async () => {
          await fixture?.cleanup();
        },
        run: async (signal) => {
          const port = await getFreePort();
          signal.throwIfAborted();
          const state = await createOpenClawTestState({
            label: "usage-sessions-owner-attribution",
            env: {
              OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
              OPENCLAW_SKIP_CANVAS_HOST: "1",
              OPENCLAW_SKIP_CHANNELS: "1",
              OPENCLAW_SKIP_CRON: "1",
              OPENCLAW_SKIP_GMAIL_WATCHER: "1",
              OPENCLAW_SKIP_PROVIDERS: "1",
              OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
              VITEST: "1",
            },
          });
          fixture = state;
          signal.throwIfAborted();

          const { startGatewayServer } = await import("../../../src/gateway/server.js");
          signal.throwIfAborted();
          const { persistSessionTranscriptTurn, upsertSessionEntryCore } =
            await import("../../../src/config/sessions/session-accessor.js");

          signal.throwIfAborted();
          await state.writeConfig({
            agents: {
              ownership: "explicit",
              defaults: { workspace: state.workspaceDir },
              entries: {
                main: { workspace: state.workspaceDir },
                opus: { workspace: state.workspaceDir },
              },
            },
            gateway: {
              mode: "local",
              port,
              bind: "loopback",
              auth: { mode: "none" },
              controlUi: { enabled: false },
            },
            plugins: { enabled: false },
            session: {
              store: path.join(state.stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
            },
          });

          for (const agentId of ["main", "opus"]) {
            signal.throwIfAborted();
            const scope = {
              agentId,
              sessionId: PROOF_SESSION_ID,
              sessionKey: agentId === "main" ? PROOF_STORE_KEY : `agent:opus:${PROOF_SESSION_ID}`,
              storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
            };
            const now = Date.now();
            if (agentId === "main") {
              await upsertSessionEntryCore(scope, {
                sessionId: PROOF_SESSION_ID,
                label: PROOF_LABEL,
                updatedAt: now,
              });
            }
            signal.throwIfAborted();
            // Both transcripts must fall inside the dashboard's current date window.
            await persistSessionTranscriptTurn(scope, {
              cwd: state.workspaceDir,
              updateMode: "none",
              messages: [
                { message: { role: "user", content: `${agentId} turn`, timestamp: now }, now },
              ],
            });
          }

          signal.throwIfAborted();
          if (resetCurrentSession) {
            await upsertSessionEntryCore(
              {
                agentId: "main",
                sessionKey: PROOF_STORE_KEY,
                storePath: path.join(state.sessionsDir("main"), "sessions.json"),
              },
              {
                sessionId: "empty-current-session",
                label: PROOF_LABEL,
                updatedAt: Date.now(),
              },
            );
          }

          signal.throwIfAborted();
          gateway = startGatewayServer(port, {
            auth: { mode: "none" },
            bind: "loopback",
            controlUiEnabled: false,
            sidecarStartup: "defer",
          });
          await gateway;
          signal.throwIfAborted();

          await suite.withPage(
            {
              locale: "en-US",
              serviceWorkers: "block",
              viewport,
            },
            async ({ page }) => {
              const pageErrors: string[] = [];
              page.on("pageerror", (error) => pageErrors.push(String(error)));

              const url = new URL("usage", suite.server.baseUrl);
              url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
              await page.goto(url.toString());
              const confirmation = page.locator("openclaw-gateway-url-confirmation");
              await confirmation.waitFor();
              await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();

              const otherRow = page.locator(
                `.session-bar-row[title="agent:opus:${PROOF_SESSION_ID}"]`,
              );
              // A rendered usage row proves the handshake and requested report both arrived.
              await otherRow.waitFor();
              await expect.poll(() => otherRow.count()).toBe(1);
              await otherRow.scrollIntoViewIfNeeded();
              await capture(
                page,
                resetCurrentSession ? "02-empty-current-family.png" : "01-same-id-owners.png",
              );

              // The named family stays visible before its new current instance has a transcript.
              const row = page.locator(`.session-bar-row[title="${PROOF_STORE_KEY}"]`);
              await row.waitFor();
              await expect.poll(() => row.count()).toBe(1);
              const meta = row.locator(".session-bar-meta");
              await expect
                .poll(async () => (await meta.textContent()) ?? "")
                .toContain("agent:main");
              await expect
                .poll(async () => (await meta.textContent()) ?? "")
                .not.toContain("agent:opus");
              await expect
                .poll(() => otherRow.locator(".session-bar-meta").textContent())
                .toContain("agent:opus");
              await expect.poll(() => page.locator(".session-bar-row").count()).toBe(2);

              await row.scrollIntoViewIfNeeded();
              await capture(
                page,
                resetCurrentSession ? "02-empty-current-family.png" : "01-same-id-owners.png",
              );
              expect(pageErrors).toEqual([]);
            },
          );
        },
      });
    },
  );
});
