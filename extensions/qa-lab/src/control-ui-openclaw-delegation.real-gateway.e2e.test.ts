import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WebSocket } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { controlUiSessionUrl } from "../../../ui/src/test-helpers/control-ui-e2e.ts";
import { createQaLiveLaneGateway } from "./live-transports/shared/live-gateway.runtime.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI OpenClaw delegation with a real Gateway",
  startServerBeforeBrowser: true,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const prompt = "tool search qa check target=openclaw openclaw_fixture=logging-level-info";

function loggingLevel(config: unknown): unknown {
  return isRecord(config) && isRecord(config.logging) ? config.logging.level : undefined;
}

function readDelegationResults(history: unknown): Record<string, unknown>[] {
  if (!isRecord(history) || !Array.isArray(history.messages)) {
    return [];
  }
  const results: Record<string, unknown>[] = [];
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
      results.push(result);
    }
  }
  return results;
}

function readDelegationResult(history: unknown): Record<string, unknown> | undefined {
  return readDelegationResults(history).at(-1);
}

suite.define(() => {
  it("renders one native approval card without exposing fallback approval text", async () => {
    const owner = createQaLiveLaneGateway();
    const proofDir = suite.artifactDir;
    const errors: unknown[] = [];
    try {
      const repoRoot = process.cwd();
      const runtime = await owner.start({
        repoRoot,
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
          agents: {
            ...cfg.agents,
            entries: {
              ...cfg.agents?.entries,
              qa: {
                ...cfg.agents?.entries?.qa,
                identity: { name: "Approval proof" },
                tools: {
                  ...cfg.agents?.entries?.qa?.tools,
                  exec: { ...cfg.agents?.entries?.qa?.tools?.exec, mode: "ask" },
                  alsoAllow: ["openclaw"],
                },
              },
            },
          },
        }),
      });
      const gateway = runtime.gateway;
      const sessionKey = "agent:qa:dashboard:delegation-approval";
      await gateway.call("sessions.create", {
        key: sessionKey,
        label: "OpenClaw native approval",
      });

      await suite.withPage(
        {
          locale: "en-US",
          ...(captureUiProof
            ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 900 } } }
            : {}),
          serviceWorkers: "block",
          viewport: { width: 1280, height: 900 },
        },
        async ({ page }) => {
          const eventSequence: string[] = [];
          let finalEvents = 0;
          let activeUiSocket: WebSocket | undefined;
          page.on("websocket", (socket) => {
            if (new URL(socket.url()).origin !== new URL(gateway.wsUrl).origin) {
              return;
            }
            // Reload briefly overlaps the retiring and replacement sockets. Observe only the
            // active UI connection so broadcast approval events are not counted twice.
            activeUiSocket = socket;
            socket.on("framereceived", ({ payload }) => {
              if (socket !== activeUiSocket) {
                return;
              }
              const frame: unknown = JSON.parse(String(payload));
              if (!isRecord(frame) || frame.type !== "event") {
                return;
              }
              if (typeof frame.event === "string" && frame.event.startsWith("openclaw.approval.")) {
                const applicationStatus =
                  isRecord(frame.payload) && typeof frame.payload.applicationStatus === "string"
                    ? `:${frame.payload.applicationStatus}`
                    : "";
                eventSequence.push(`${frame.event}${applicationStatus}`);
              }
              if (
                frame.event === "chat" &&
                isRecord(frame.payload) &&
                frame.payload.sessionKey === sessionKey &&
                frame.payload.state === "final"
              ) {
                finalEvents += 1;
                eventSequence.push("chat.final");
              }
            });
          });
          await page.addInitScript(
            ({ gatewayUrl, token }) => {
              const proofWindow = window as Window & {
                __OPENCLAW_APPROVAL_UI_SEQUENCE__?: string[];
                __OPENCLAW_APPROVAL_FALLBACK_OBSERVED__?: boolean;
                __OPENCLAW_NATIVE_CONTROL_AUTH__?: { gatewayUrl: string; token: string };
              };
              proofWindow["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl, token };
              proofWindow["__OPENCLAW_APPROVAL_UI_SEQUENCE__"] = [];
              proofWindow["__OPENCLAW_APPROVAL_FALLBACK_OBSERVED__"] = false;
              const fallbackMarkers = [
                "OpenClaw change pending approval",
                "/approve",
                "needsApproval",
                "proposalId",
              ];
              const containsFallback = (text: string | null) =>
                fallbackMarkers.some((marker) => text?.includes(marker));
              new MutationObserver((mutations) => {
                for (const record of mutations) {
                  const changedText =
                    record.type === "characterData"
                      ? [record.target.textContent]
                      : [...record.addedNodes].map((node) => node.textContent);
                  if (changedText.some(containsFallback)) {
                    proofWindow["__OPENCLAW_APPROVAL_FALLBACK_OBSERVED__"] = true;
                  }
                }
              }).observe(document, { childList: true, characterData: true, subtree: true });
              const NativeWebSocket = window.WebSocket;
              window.WebSocket = class extends NativeWebSocket {
                constructor(url: string | URL, protocols?: string | string[]) {
                  super(url, protocols ?? []);
                  this.addEventListener("message", (event) => {
                    try {
                      const frame = JSON.parse(String(event.data)) as {
                        event?: unknown;
                        payload?: {
                          applicationStatus?: unknown;
                          sessionKey?: unknown;
                        };
                        type?: unknown;
                      };
                      if (frame.type !== "event") {
                        return;
                      }
                      if (frame.event === "openclaw.approval.resolved") {
                        const applicationStatus =
                          typeof frame.payload?.applicationStatus === "string"
                            ? `:${frame.payload.applicationStatus}`
                            : "";
                        proofWindow["__OPENCLAW_APPROVAL_UI_SEQUENCE__"]?.push(
                          `openclaw.approval.resolved${applicationStatus}`,
                        );
                      }
                    } catch {
                      // Ignore non-JSON frames from unrelated WebSocket traffic.
                    }
                  });
                }
              };
            },
            { gatewayUrl: gateway.wsUrl, token: gateway.token },
          );
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          const composer = page.locator(".agent-chat__composer-combobox textarea");
          await composer.fill(prompt);
          await page.getByRole("button", { name: "Send message" }).click();

          const approvalCard = page.locator(
            '.chat-inline-approval [data-approval-id^="system-agent:"]',
          );
          await approvalCard.waitFor();
          await expect.poll(() => approvalCard.count()).toBe(1);
          expect(eventSequence).toEqual(["openclaw.approval.requested"]);
          expect(finalEvents).toBe(0);
          expect(loggingLevel(JSON.parse(await readFile(gateway.configPath, "utf8")))).toBe(
            "debug",
          );

          const pendingHistory = await gateway.call("chat.history", { sessionKey, limit: 30 });
          expect(readDelegationResults(pendingHistory)).toEqual([]);
          const pendingTranscript = JSON.stringify(pendingHistory);
          expect(pendingTranscript).not.toContain("/approve");
          expect(pendingTranscript).not.toContain("needsApproval");
          expect(pendingTranscript).not.toContain("proposalId");
          const pendingPageText = await page.locator("body").textContent();
          expect(pendingPageText).not.toContain("OpenClaw change pending approval");
          expect(pendingPageText).not.toContain("/approve");
          expect(pendingPageText).not.toContain("needsApproval");
          expect(pendingPageText).not.toContain("proposalId");
          if (captureUiProof) {
            await page.screenshot({ path: path.join(proofDir, "01-native-approval.png") });
          }

          const approvalFallbackWasObserved = () =>
            page.evaluate(
              () =>
                (
                  window as Window & {
                    __OPENCLAW_APPROVAL_FALLBACK_OBSERVED__?: boolean;
                  }
                )["__OPENCLAW_APPROVAL_FALLBACK_OBSERVED__"] === true,
            );
          expect(await approvalFallbackWasObserved()).toBe(false);
          await page.reload();
          await composer.waitFor();
          await approvalCard.waitFor();
          await expect.poll(() => approvalCard.count()).toBe(1);
          expect(eventSequence).toEqual(["openclaw.approval.requested"]);
          expect(finalEvents).toBe(0);
          expect(
            readDelegationResults(await gateway.call("chat.history", { sessionKey, limit: 30 })),
          ).toEqual([]);
          const reloadedPendingPageText = await page.locator("body").textContent();
          expect(reloadedPendingPageText).not.toContain("OpenClaw change pending approval");
          expect(reloadedPendingPageText).not.toContain("/approve");
          expect(reloadedPendingPageText).not.toContain("needsApproval");
          expect(reloadedPendingPageText).not.toContain("proposalId");

          await approvalCard.evaluate((card) => {
            const proofWindow = window as unknown as {
              __OPENCLAW_APPROVAL_UI_SEQUENCE__: string[];
            };
            const observer = new MutationObserver(() => {
              if (card.isConnected) {
                return;
              }
              observer.disconnect();
              proofWindow["__OPENCLAW_APPROVAL_UI_SEQUENCE__"].push("approval.card.removed");
            });
            observer.observe(document.body, { childList: true, subtree: true });
          });

          await approvalCard.getByRole("button", { name: "Allow once" }).click();
          await expect.poll(() => approvalCard.count()).toBe(0);
          await expect.poll(() => finalEvents, { timeout: 60_000 }).toBe(1);
          expect(eventSequence).toEqual([
            "openclaw.approval.requested",
            "openclaw.approval.resolved",
            "openclaw.approval.resolved:applied",
            "chat.final",
          ]);
          const approvalUiSequence = await page.evaluate(
            () =>
              (window as unknown as { __OPENCLAW_APPROVAL_UI_SEQUENCE__: string[] })[
                "__OPENCLAW_APPROVAL_UI_SEQUENCE__"
              ],
          );
          expect(approvalUiSequence).toHaveLength(3);
          expect(approvalUiSequence).toEqual(
            expect.arrayContaining([
              "openclaw.approval.resolved",
              "approval.card.removed",
              "openclaw.approval.resolved:applied",
            ]),
          );
          expect(approvalUiSequence.at(-1)).toBe("openclaw.approval.resolved:applied");

          const history = await gateway.call("chat.history", { sessionKey, limit: 30 });
          const results = readDelegationResults(history);
          expect(results).toHaveLength(1);
          expect(results[0]?.needsApproval).not.toBe(true);
          expect(results[0]?.proposalId).toBeUndefined();
          expect(results[0]?.reply).toContain("Updated logging.level");
          expect(JSON.stringify(history)).not.toContain("/approve");
          expect(loggingLevel(JSON.parse(await readFile(gateway.configPath, "utf8")))).toBe("info");
          expect(await approvalFallbackWasObserved()).toBe(false);
          await page.reload();
          await composer.waitFor();
          await page.getByText(prompt, { exact: true }).waitFor();
          await expect.poll(() => approvalCard.count()).toBe(0);
          const reloadedWorkSummary = page
            .locator(".chat-work-group > .chat-activity-group__summary")
            .first();
          await reloadedWorkSummary.waitFor();
          if ((await reloadedWorkSummary.getAttribute("aria-expanded")) !== "true") {
            await reloadedWorkSummary.click();
          }
          const reloadedToolSummaries = page.locator(".chat-tool-msg-summary");
          await reloadedToolSummaries.first().waitFor();
          for (const summary of await reloadedToolSummaries.all()) {
            await summary.click();
          }
          await page
            .locator(".chat-tool-msg-body", { hasText: /Updated logging\.level/u })
            .waitFor();
          const reloadedPageText = await page.locator("body").textContent();
          expect(reloadedPageText).not.toContain("OpenClaw change pending approval");
          expect(reloadedPageText).not.toContain("/approve");
          expect(reloadedPageText).not.toContain("needsApproval");
          expect(reloadedPageText).not.toContain("proposalId");
          expect(await approvalFallbackWasObserved()).toBe(false);
        },
      );
    } catch (error) {
      errors.push(error);
    }
    const stopped = await owner.stop({ preserveToDir: path.join(proofDir, "gateway") });
    errors.push(...stopped.errors);
    if (errors.length > 0) {
      throw new AggregateError(errors, "native OpenClaw approval proof failed");
    }
  }, 180_000);

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
            ...(captureUiProof
              ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 900 } } }
              : {}),
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
            if (captureUiProof) {
              await page.screenshot({ path: path.join(proofDir, "01-request.png") });
            }
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
            if (captureUiProof) {
              await page.screenshot({ path: path.join(proofDir, "02-applied.png") });
            }
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
