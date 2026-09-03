import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import type {
  BoardWidgetAppViewResult,
  BoardWidgetPutResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  TEST_TIMEOUT_MS,
  createChildEnv,
  startHttpFixture,
  stopChild,
  waitForMcpFixtureGate,
  type GatewayHandle,
  type HttpFixture,
} from "./gateway-node-mcp.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const APP_TOOL_NAME = "streamableHttp__parity_app";
const POST_REVOCATION_MARKER = "post-revocation";

function requireMcpAppViewId(messages: unknown[]): string {
  for (const message of messages) {
    if (!isRecord(message) || message.toolName !== APP_TOOL_NAME || !isRecord(message.details)) {
      continue;
    }
    const preview = message.details.mcpAppPreview;
    const mcpApp = isRecord(preview) ? preview.mcpApp : undefined;
    if (isRecord(mcpApp) && typeof mcpApp.viewId === "string") {
      return mcpApp.viewId;
    }
  }
  throw new Error(`chat.history omitted the persisted MCP App view for ${APP_TOOL_NAME}`);
}

async function readExecutedMarkers(eventPath: string): Promise<string[]> {
  const content = await fs.readFile(eventPath, "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .flatMap((event) =>
      isRecord(event) && typeof event.marker === "string" ? [event.marker] : [],
    );
}

function appConfig(cfg: OpenClawConfig, fixture: HttpFixture): OpenClawConfig {
  return {
    ...cfg,
    mcp: {
      ...cfg.mcp,
      apps: { ...cfg.mcp?.apps, enabled: true },
      servers: {
        streamableHttp: {
          transport: "streamable-http",
          url: fixture.urls.streamableHttp,
          connectionTimeoutMs: 30_000,
          requestTimeoutMs: 30_000,
          toolFilter: { include: ["parity_app"] },
        },
      },
    },
    tools: {
      ...cfg.tools,
      profile: "full",
      toolSearch: false,
      codeMode: false,
      exec: { ...cfg.tools?.exec, mode: "ask" },
    },
    channels: {},
  };
}

async function postStandalone(params: {
  gateway: GatewayHandle;
  ticket: string;
  marker: string;
}): Promise<Response> {
  return await fetch(new URL("/__openclaw__/mcp-app/view", params.gateway.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `MCP-App ${params.ticket}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      method: "tools/call",
      params: { name: "parity_app", arguments: { marker: params.marker } },
    }),
  });
}

async function readStandaloneResource(params: {
  gateway: GatewayHandle;
  ticket: string;
}): Promise<Response> {
  return await fetch(new URL("/__openclaw__/mcp-app/view", params.gateway.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `MCP-App ${params.ticket}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      method: "resources/read",
      params: { uri: "ui://parity/app" },
    }),
  });
}

describe("Gateway MCP App board grant revalidation", () => {
  it(
    "rejects a standalone tool call revoked during a real catalog refresh",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const repoRoot = process.cwd();
      const taskRoot = tempDirs.make("openclaw-mcp-app-grant-revalidation-");
      const fixtureRoot = path.join(taskRoot, "fixture");
      const fixtureHome = path.join(fixtureRoot, "home");
      const fixtureTemp = path.join(fixtureRoot, "tmp");
      const gateDir = path.join(fixtureRoot, "catalog-gate");
      const eventPath = path.join(fixtureRoot, "app-calls.jsonl");
      const armPath = path.join(gateDir, "arm");
      const startedPath = path.join(gateDir, "started");
      const releasePath = path.join(gateDir, "release");
      const gatewayParent = path.join(taskRoot, "gateway");
      const fixturePath = path.join(
        repoRoot,
        "test/e2e/qa-lab/runtime/gateway-node-mcp.fixture.mjs",
      );
      let fixture: HttpFixture | undefined;
      let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
      const gatewayOwner = createQaGatewayChild();
      let gateway: GatewayHandle | undefined;
      let pendingCall: Promise<Response> | undefined;
      let proofError: unknown;
      const cleanupErrors: unknown[] = [];

      try {
        await Promise.all(
          [fixtureHome, fixtureTemp, gateDir, gatewayParent].map((directory) =>
            fs.mkdir(directory, { recursive: true }),
          ),
        );
        fixture = await startHttpFixture({
          fixturePath,
          labelPrefix: "session",
          env: createChildEnv({
            home: fixtureHome,
            tempDir: fixtureTemp,
            extra: {
              MCP_APP_GRANT_REVALIDATION_FIXTURE: "1",
              MCP_APP_CATALOG_GATE_DIR: gateDir,
              MCP_APP_EVENT_PATH: eventPath,
            },
          }),
        });
        mock = await startQaMockOpenAiServer();
        const activeFixture = fixture;
        gateway = await gatewayOwner.start({
          repoRoot,
          command: {
            executablePath: process.execPath,
            argsPrefix: ["dist/index.js"],
            cwd: repoRoot,
            tempParentDir: gatewayParent,
            usePackagedPlugins: true,
          },
          providerBaseUrl: `${mock.baseUrl}/v1`,
          providerMode: "mock-openai",
          primaryModel: "mock-openai/gpt-5.6-luna",
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          runtimeEnvPatch: { OPENCLAW_SKIP_CHANNELS: "1" },
          mutateConfig: (cfg) => appConfig(cfg, activeFixture),
        });

        const sessionKey = `agent:qa:mcp-app-grant-${randomUUID()}`;
        const started = (await gateway.call(
          "agent",
          {
            sessionKey,
            message: `Tool search QA check target=${APP_TOOL_NAME}. Call exactly that tool once and then summarize.`,
            deliver: false,
            idempotencyKey: randomUUID(),
          },
          { timeoutMs: 30_000 },
        )) as { runId?: unknown; status?: unknown };
        if (started.status !== "accepted" || typeof started.runId !== "string") {
          throw new Error(`mock-provider App turn did not start: ${JSON.stringify(started)}`);
        }
        await expect(
          gateway.call(
            "agent.wait",
            { runId: started.runId, timeoutMs: 60_000 },
            { timeoutMs: 65_000 },
          ),
        ).resolves.toMatchObject({ runId: started.runId, status: "ok" });
        const history = (await gateway.call("chat.history", {
          sessionKey,
          limit: 50,
        })) as { messages?: unknown[] };
        const sourceViewId = requireMcpAppViewId(history.messages ?? []);

        const pinned = (await gateway.call("board.widget.put", {
          sessionKey,
          name: "grant-proof",
          content: { kind: "mcp-app", viewId: sourceViewId },
        })) as BoardWidgetPutResult;
        const widget = pinned.widgets.find((candidate) => candidate.name === "grant-proof");
        if (!widget?.instanceId) {
          throw new Error("board.widget.put omitted the exact widget revision identity");
        }
        expect(widget.grantState).toBe("pending");
        await gateway.call("board.widget.grant", {
          sessionKey,
          name: widget.name,
          decision: "granted",
          revision: widget.revision,
          instanceId: widget.instanceId,
        });
        const reminted = (await gateway.call("board.widget.appView", {
          sessionKey,
          name: widget.name,
          revision: widget.revision,
          instanceId: widget.instanceId,
        })) as BoardWidgetAppViewResult;
        const appView = (await gateway.call("mcp.app.view", {
          sessionKey,
          viewId: reminted.viewId,
        })) as { standaloneUrl?: unknown };
        if (typeof appView.standaloneUrl !== "string") {
          throw new Error("mcp.app.view omitted the standalone ticket URL");
        }
        const standaloneUrl = new URL(appView.standaloneUrl, gateway.baseUrl);
        const ticket = standaloneUrl.hash.slice(1);
        expect(ticket).not.toBe("");

        const allowedResource = await readStandaloneResource({ gateway, ticket });
        const allowedResourceBody: unknown = await allowedResource.json();
        expect(allowedResource.status).toBe(200);
        expect(JSON.stringify(allowedResourceBody)).toContain("Parity MCP App");

        await fs.writeFile(armPath, "armed\n");
        const notificationCall = await postStandalone({
          gateway,
          ticket,
          marker: "notify-list-changed",
        });
        expect(notificationCall.status).toBe(200);

        pendingCall = postStandalone({ gateway, ticket, marker: POST_REVOCATION_MARKER });
        await waitForMcpFixtureGate(startedPath);
        await gateway.call("board.update", {
          sessionKey,
          ops: [{ kind: "widget_remove", name: widget.name }],
        });
        await fs.writeFile(releasePath, "released\n");

        const denied = await pendingCall;
        const deniedBody: unknown = await denied.json();
        const deniedResource = await readStandaloneResource({ gateway, ticket });
        const deniedResourceBody: unknown = await deniedResource.json();
        const executedMarkers = await readExecutedMarkers(eventPath);
        expect({
          status: denied.status,
          error: isRecord(deniedBody) ? deniedBody.error : undefined,
          resourceStatus: deniedResource.status,
          resourceError: isRecord(deniedResourceBody) ? deniedResourceBody.error : undefined,
          leakedResource: JSON.stringify(deniedResourceBody).includes("Parity MCP App"),
          postRevocationExecuted: executedMarkers.includes(POST_REVOCATION_MARKER),
        }).toEqual({
          status: 403,
          error: "MCP App widget grant is no longer active",
          resourceStatus: 403,
          resourceError: "MCP App widget grant is no longer active",
          leakedResource: false,
          postRevocationExecuted: false,
        });
      } catch (error) {
        proofError = error;
      } finally {
        await fs.writeFile(releasePath, "released\n").catch(() => {});
        await pendingCall?.catch(() => {});
        const stopped = await Promise.allSettled([
          stopQaGatewayFixture(gatewayOwner),
          ...(fixture ? [stopChild(fixture)] : []),
          ...(mock ? [Promise.resolve(mock.stop())] : []),
        ]);
        cleanupErrors.push(
          ...stopped.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        );
      }

      const failures = proofError === undefined ? cleanupErrors : [proofError, ...cleanupErrors];
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "MCP App grant revalidation proof failed");
      }
    },
  );
});
