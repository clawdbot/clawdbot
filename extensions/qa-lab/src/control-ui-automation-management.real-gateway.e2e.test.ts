import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { controlUiSessionUrl } from "../../../ui/src/test-helpers/control-ui-e2e.ts";
import { createQaCrablineTransportAdapter } from "./crabline-transport.ts";
import { createQaGatewayChild } from "./gateway-child.ts";
import { buildAssistantEvents } from "./providers/mock-openai/mock-openai-events.ts";
import {
  extractLastUserText,
  extractToolOutput,
  hasToolOutput,
} from "./providers/mock-openai/mock-openai-input.ts";
import { buildToolCallEventsWithArgs } from "./providers/mock-openai/mock-openai-tooling.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cross-channel automation management with a real Gateway",
  startServerBeforeBrowser: true,
});

type AutomationAction = "list" | "get" | "update" | "run" | "remove";
const actions = ["list", "get", "update", "run", "remove"] as const;
const automationName = "Telegram-created reminder";
const updatedReminderMessage = "Complete the reminder updated from Control UI.";
const scheduledReply = "Scheduled reminder completed.";

function readResult(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error("Automation tool returned no object result");
  }
  return value;
}

async function startAutomationProvider() {
  const requests = new Map<string, Record<string, unknown>>();
  const results = new Map<string, string>();
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!isRecord(body) || !Array.isArray(body.input)) {
        throw new Error("Expected a Responses request");
      }
      const input = body.input.filter(isRecord);
      const marker = /\[automation-proof:([a-z-]+)\]/u.exec(extractLastUserText(input))?.[1];
      const args = marker ? requests.get(marker) : undefined;
      const output = extractToolOutput(input);
      if (marker && args && hasToolOutput(input)) {
        results.set(marker, output);
      }
      const events =
        args && !hasToolOutput(input)
          ? buildToolCallEventsWithArgs("automations", args)
          : buildAssistantEvents(marker && args ? `${marker}: ${output}` : scheduledReply);
      if (body.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      } else {
        const completed = events.find((event) => event.type === "response.completed");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(completed?.response));
      }
    })().catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Automation provider did not bind a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    results,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function managementArgs(action: AutomationAction, jobId: string) {
  return {
    action,
    ...(action === "list" ? { includeDisabled: true } : { jobId }),
    ...(action === "update"
      ? {
          job: {
            name: "Reminder updated from Control UI",
            payload: { message: updatedReminderMessage },
          },
        }
      : {}),
    ...(action === "run" ? { runMode: "force" } : {}),
  };
}

suite.define(() => {
  it(
    "admin chat manages a Telegram-created job while another Telegram caller is denied",
    {
      timeout: 240_000,
    },
    async () => {
      const proofDir = suite.artifactDir;
      const provider = await startAutomationProvider();
      const owner = createQaGatewayChild();
      const transport = await createQaCrablineTransportAdapter({
        outputDir: proofDir,
        selection: {
          channel: "telegram",
          channelDriver: "crabline",
          capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
          providerReadinessArtifactPath: "crabline-provider-readiness.json",
        },
      });
      const errors: unknown[] = [];
      try {
        const repoRoot = process.cwd();
        const gateway = await owner.start({
          repoRoot,
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.join(repoRoot, "openclaw.mjs")],
            cwd: repoRoot,
            usePackagedPlugins: true,
          },
          providerMode: "mock-openai",
          providerBaseUrl: provider.baseUrl,
          primaryModel: "mock-openai/gpt-5.6-luna",
          alternateModel: "mock-openai/gpt-5.6-luna-alt",
          forcedRuntime: "openclaw",
          transport,
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          controlUiAllowedOrigins: [new URL(suite.server.baseUrl).origin],
          mutateConfig: (cfg) => ({
            ...cfg,
            // Both channel senders may use automation tools; neither is a Control UI administrator.
            commands: { ...cfg.commands, ownerAllowFrom: ["telegram:100001", "telegram:100002"] },
            session: { ...cfg.session, dmScope: "per-channel-peer" },
            plugins: { ...cfg.plugins, slots: { ...cfg.plugins?.slots, memory: "none" } },
            memory: { ...cfg.memory, search: { ...cfg.memory?.search, enabled: false } },
            tools: { profile: "full", allow: ["automations"], codeMode: false, toolSearch: false },
            agents: {
              ...cfg.agents,
              entries: {
                ...cfg.agents?.entries,
                qa: {
                  ...cfg.agents?.entries?.qa,
                  identity: { name: "Automation proof" },
                  tools: { profile: "full", allow: ["automations"] },
                },
              },
            },
          }),
        });
        await transport.waitReady({ gateway });
        provider.requests.set("create", {
          action: "add",
          job: {
            name: automationName,
            enabled: false,
            schedule: { kind: "every", everyMs: 3_600_000 },
            sessionTarget: "isolated",
            payload: { kind: "agentTurn", message: "Complete this synthetic reminder." },
            delivery: { mode: "none" },
          },
        });
        await transport.sendInbound({
          accountId: transport.accountId,
          conversation: { id: "100001", kind: "direct" },
          senderId: "100001",
          text: "Create a disabled hourly reminder. [automation-proof:create]",
        });
        await transport.waitForOutbound({ textIncludes: "create:", timeoutMs: 60_000 });
        const created = readResult(provider.results.get("create") ?? "null");
        expect(created).toMatchObject({
          name: automationName,
          owner: { sessionKey: expect.stringContaining(":telegram:") },
          scheduledToolPolicy: { mode: "account" },
          payload: {
            kind: "agentTurn",
            toolsAllow: expect.arrayContaining(["automations"]),
            toolsAllowIsDefault: true,
          },
        });
        if (!isRecord(created.payload)) {
          throw new Error("Created automation has no payload");
        }
        const creatorPayload = created.payload;
        expect(typeof created.id).toBe("string");
        const jobId = String(created.id);
        const channelResults: Record<string, string> = {};
        for (const action of actions) {
          const marker = `channel-${action}`;
          provider.requests.set(marker, managementArgs(action, jobId));
          const outboundIndex = transport.state
            .getSnapshot()
            .messages.filter((message) => message.direction === "outbound").length;
          await transport.sendInbound({
            accountId: transport.accountId,
            conversation: { id: "100002", kind: "direct" },
            senderId: "100002",
            text: `Manage the other conversation's reminder. [automation-proof:${marker}]`,
          });
          const reply = await transport.waitForOutbound({
            textIncludes: `${marker}:`,
            sinceIndex: outboundIndex,
            timeoutMs: 60_000,
          });
          const output = provider.results.get(marker) ?? "";
          if (action === "list") {
            expect(readResult(output).jobs).not.toEqual(
              expect.arrayContaining([expect.objectContaining({ id: jobId })]),
            );
          } else {
            expect(output).toMatch(/not found|denied|not authorized|not accessible/iu);
            expect(output).toMatch(/list automations|Control UI|retry/iu);
          }
          expect(reply.text.replace(/\s+/gu, " ")).toContain(output.replace(/\s+/gu, " "));
          channelResults[action] = action === "list" ? "hidden" : "denied visibly";
        }

        const sessionKey = `agent:qa:dashboard:automation-management-${randomUUID()}`;
        await gateway.call("sessions.create", {
          key: sessionKey,
          label: "Manage Telegram reminder",
        });
        const adminResults: Record<string, string> = {};
        await suite.withPage(
          {
            locale: "en-US",
            recordVideo: { dir: proofDir, size: { width: 1280, height: 900 } },
            viewport: { width: 1280, height: 900 },
            serviceWorkers: "block",
          },
          async ({ page }) => {
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
            for (const action of actions) {
              const marker = `admin-${action}`;
              provider.requests.set(marker, managementArgs(action, jobId));
              await page
                .locator(".agent-chat__composer-combobox textarea")
                .fill(`${action} the Telegram-created reminder. [automation-proof:${marker}]`);
              await page.screenshot({ path: path.join(proofDir, `${marker}-request.png`) });
              await page.getByRole("button", { name: "Send message" }).click();
              await expect.poll(() => provider.results.has(marker), { timeout: 60_000 }).toBe(true);
              const result = readResult(provider.results.get(marker) ?? "null");
              if (action === "list") {
                expect(result.jobs).toEqual(
                  expect.arrayContaining([expect.objectContaining({ id: jobId })]),
                );
              } else if (action === "get") {
                expect(result).toMatchObject({ id: jobId, name: automationName });
              } else if (action === "update") {
                const updatedJob = {
                  id: jobId,
                  name: "Reminder updated from Control UI",
                  payload: { ...creatorPayload, message: updatedReminderMessage },
                  owner: created.owner,
                  scheduledToolPolicy: created.scheduledToolPolicy,
                };
                expect(result).toEqual(expect.objectContaining(updatedJob));
                expect(await gateway.call("cron.get", { id: jobId })).toEqual(
                  expect.objectContaining(updatedJob),
                );
              } else if (action === "run") {
                expect(result).toMatchObject({ ok: true });
                await expect
                  .poll(
                    async () => {
                      const runs = await gateway.call("cron.runs", { id: jobId });
                      return (
                        isRecord(runs) &&
                        Array.isArray(runs.entries) &&
                        runs.entries.some((entry) => isRecord(entry) && entry.status === "ok")
                      );
                    },
                    { timeout: 60_000 },
                  )
                  .toBe(true);
              } else {
                expect(result).toMatchObject({ removed: true });
              }
              await page
                .getByText(new RegExp(`^${marker}:`, "u"))
                .first()
                .waitFor();
              await page.screenshot({ path: path.join(proofDir, `${marker}-result.png`) });
              adminResults[action] = "succeeded";
            }
          },
        );
        const auditEvents = gateway
          .logs()
          .split("\n")
          .filter((line) => line.includes("cron: admin management"));
        expect(auditEvents).toHaveLength(actions.length);
        await writeFile(
          path.join(proofDir, "verdict.json"),
          `${JSON.stringify(
            {
              gateway: "real isolated Gateway",
              channel: "real Telegram plugin with synthetic Crabline Bot API",
              provider: "deterministic local Responses API",
              creator: "Telegram conversation",
              admin: adminResults,
              otherTelegramConversation: channelResults,
              adminManagementAuditEvents: auditEvents.length,
            },
            null,
            2,
          )}\n`,
        );
      } catch (error) {
        errors.push(error);
      }
      const stopped = await owner.stop({ preserveToDir: path.join(proofDir, "gateway") });
      errors.push(...stopped.errors);
      for (const stop of [() => transport.cleanup(), () => provider.stop()]) {
        try {
          await stop();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, "Cross-channel automation management proof failed");
      }
    },
  );
});
