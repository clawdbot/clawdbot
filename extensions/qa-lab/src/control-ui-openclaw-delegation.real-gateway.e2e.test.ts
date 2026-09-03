import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { controlUiSessionUrl } from "../../../ui/src/test-helpers/control-ui-e2e.ts";
import { createQaLiveLaneGateway } from "./live-transports/shared/live-gateway.runtime.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Full Access OpenClaw delegation with a real Gateway",
  startServerBeforeBrowser: true,
});

const prompt = "tool search qa check target=openclaw openclaw_fixture=logging-level-info";

function loggingLevel(config: unknown): unknown {
  return isRecord(config) && isRecord(config.logging) ? config.logging.level : undefined;
}

function readDelegationResult(history: unknown): Record<string, unknown> | undefined {
  if (!isRecord(history) || !Array.isArray(history.messages)) {
    return undefined;
  }
  for (const message of history.messages) {
    if (
      !isRecord(message) ||
      message.role !== "toolResult" ||
      message.toolName !== "openclaw" ||
      !Array.isArray(message.content)
    ) {
      continue;
    }
    const text = message.content
      .flatMap((block) =>
        isRecord(block) && block.type === "text" && typeof block.text === "string"
          ? [block.text]
          : [],
      )
      .join("\n");
    const result: unknown = JSON.parse(text);
    if (isRecord(result)) {
      return result;
    }
  }
  return undefined;
}

suite.define(() => {
  it.each(["default", "full"] as const)(
    "%s Full Access saves a delegated config change without a system-agent approval",
    { timeout: 180_000 },
    async (mode) => {
      const owner = createQaLiveLaneGateway();
      const proofDir = suite.artifactDir;
      const errors: unknown[] = [];
      try {
        const repoRoot = process.cwd();
        const runtime = await owner.start({
          repoRoot,
          // The isolated HOME must not make the development launcher rebuild the checkout.
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.join(repoRoot, "openclaw.mjs")],
            cwd: repoRoot,
            usePackagedPlugins: true,
          },
          providerMode: "mock-openai",
          primaryModel: "mock-openai/gpt-5.6-luna",
          alternateModel: "mock-openai/gpt-5.6-luna-alt",
          transport: { requiredPluginIds: [], createGatewayConfig: () => ({}) },
          transportBaseUrl: "http://127.0.0.1",
          controlUiAllowedOrigins: [new URL(suite.server.baseUrl).origin],
          controlUiEnabled: false,
          mutateConfig: (cfg) => ({
            ...cfg,
            logging: { ...cfg.logging, level: "debug" },
            tools: { ...cfg.tools, exec: { ...cfg.tools?.exec, mode: "full" } },
            agents: {
              ...cfg.agents,
              entries: {
                ...cfg.agents?.entries,
                qa: {
                  ...cfg.agents?.entries?.qa,
                  identity: { name: "Approval proof" },
                  tools: {
                    ...cfg.agents?.entries?.qa?.tools,
                    alsoAllow: ["openclaw"],
                  },
                },
              },
            },
          }),
        });
        const gateway = runtime.gateway;
        const sessionKey = `agent:qa:dashboard:delegation-${mode}`;
        const created = await gateway.call("sessions.create", {
          key: sessionKey,
          label: mode === "full" ? "Full Access delegation" : "Default Full Access delegation",
          ...(mode === "full" ? { permissionMode: "full" } : {}),
        });
        expect(created).toMatchObject({ key: sessionKey });
        const entry = isRecord(created) && isRecord(created.entry) ? created.entry : undefined;
        expect(entry?.permissionMode).toBe(mode === "full" ? "full" : undefined);
        expect(loggingLevel(JSON.parse(await readFile(gateway.configPath, "utf8")))).toBe("debug");

        await suite.withPage(
          {
            locale: "en-US",
            recordVideo: { dir: proofDir, size: { width: 1280, height: 900 } },
            serviceWorkers: "block",
            viewport: { width: 1280, height: 900 },
          },
          async ({ page }) => {
            const approvalEvents: string[] = [];
            let finalEvents = 0;
            // Observe the real UI connection, not a mocked approval registry or emitted event.
            page.on("websocket", (socket) => {
              if (new URL(socket.url()).origin !== new URL(gateway.wsUrl).origin) {
                return;
              }
              socket.on("framereceived", ({ payload }) => {
                const frame: unknown = JSON.parse(String(payload));
                if (!isRecord(frame) || frame.type !== "event") {
                  return;
                }
                if (
                  typeof frame.event === "string" &&
                  frame.event.startsWith("openclaw.approval.")
                ) {
                  approvalEvents.push(frame.event);
                }
                if (
                  frame.event === "chat" &&
                  isRecord(frame.payload) &&
                  frame.payload.sessionKey === sessionKey &&
                  frame.payload.state === "final"
                ) {
                  finalEvents += 1;
                }
              });
            });
            await page.addInitScript(
              ({ gatewayUrl, token }) => {
                (
                  window as Window & {
                    __OPENCLAW_NATIVE_CONTROL_AUTH__?: { gatewayUrl: string; token: string };
                  }
                )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl, token };
              },
              { gatewayUrl: gateway.wsUrl, token: gateway.token },
            );
            await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
            const composer = page.locator(".agent-chat__composer-combobox textarea");
            await composer.fill(prompt);
            await page.screenshot({ path: path.join(proofDir, "01-request.png") });
            await page.getByRole("button", { name: "Send message" }).click();

            await expect.poll(() => finalEvents, { timeout: 60_000 }).toBeGreaterThan(0);
            const history = await gateway.call("chat.history", { sessionKey, limit: 30 });
            const result = readDelegationResult(history);
            expect(result).toBeDefined();
            expect(result?.needsApproval).not.toBe(true);
            expect(result?.proposalId).toBeUndefined();
            expect(result?.reply).toContain("Updated logging.level");
            expect(approvalEvents).toEqual([]);

            const savedConfig: unknown = JSON.parse(await readFile(gateway.configPath, "utf8"));
            expect(loggingLevel(savedConfig)).toBe("info");
            const configSnapshot = await gateway.call("config.get", {});
            expect(isRecord(configSnapshot) && loggingLevel(configSnapshot.config)).toBe("info");
            await page.locator(".chat-work-group > .chat-activity-group__summary").first().click();
            const toolSummaries = page.locator(".chat-tool-msg-summary");
            await toolSummaries.first().waitFor();
            for (const summary of await toolSummaries.all()) {
              await summary.click();
            }
            const appliedResult = page.getByText(/Updated logging\.level/u).first();
            await appliedResult.waitFor();
            await appliedResult.scrollIntoViewIfNeeded();
            expect(await page.locator(".chat-inline-approval [data-approval-id]").count()).toBe(0);
            await page.screenshot({ path: path.join(proofDir, "02-applied.png") });
            // Keep public proof independent of runtime tokens, paths, model metadata, and run ids.
            await writeFile(
              path.join(proofDir, "verdict.json"),
              `${JSON.stringify(
                {
                  mode,
                  initialLoggingLevel: "debug",
                  savedLoggingLevel: loggingLevel(savedConfig),
                  finalDelegateResultObserved: true,
                  finalChatObserved: finalEvents > 0,
                  needsApproval: result?.needsApproval === true,
                  systemAgentApprovalEvents: approvalEvents,
                },
                null,
                2,
              )}\n`,
            );
          },
        );
      } catch (error) {
        errors.push(error);
      }
      const stopped = await owner.stop({ preserveToDir: path.join(proofDir, "gateway") });
      errors.push(...stopped.errors);
      if (errors.length > 0) {
        throw new AggregateError(errors, `Full Access delegation proof failed (${mode})`);
      }
    },
  );
});
