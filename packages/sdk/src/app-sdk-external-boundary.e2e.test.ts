// Scenario-owned proof for the source-internal preview App SDK package boundary.
import { describe, it } from "vitest";
import { createPackedSdkConsumer } from "./package.e2e.test-support.js";

describe("external preview App SDK boundary", () => {
  it("packs an external consumer that uses only the exported entrypoint and a custom transport", async () => {
    const consumer = await createPackedSdkConsumer();
    try {
      await consumer.typecheck(`
        import type {
          AgentsCreateParams,
          AgentsDeleteParams,
          AgentsUpdateParams,
          ArtifactSummary,
          ArtifactsDownloadResult,
          EnvironmentSummary,
          EnvironmentsListResult,
          GatewayArtifactSummary,
          SessionCreateParams,
          SessionSendParams,
          TaskSummary,
          TasksCancelResult,
          TasksGetResult,
          TasksListParams,
          TasksListResult,
          ToolsEffectiveParams,
          ToolInvokeParams,
          ToolInvokeResult,
          WorkerEnvironmentMetadata,
          WorkerEnvironmentState,
          WorkerTunnelStatus,
        } from "@openclaw/sdk";
        import type {
          AgentsCreateParams as ProtocolAgentsCreateParams,
          AgentsDeleteParams as ProtocolAgentsDeleteParams,
          AgentsUpdateParams as ProtocolAgentsUpdateParams,
          ArtifactSummary as ProtocolArtifactSummary,
          TaskSummary as ProtocolTaskSummary,
          TasksCancelResult as ProtocolTasksCancelResult,
          TasksGetResult as ProtocolTasksGetResult,
          TasksListParams as ProtocolTasksListParams,
          TasksListResult as ProtocolTasksListResult,
          ToolsEffectiveParams as ProtocolToolsEffectiveParams,
          WorkerEnvironmentMetadata as ProtocolWorkerEnvironmentMetadata,
          WorkerEnvironmentState as ProtocolWorkerEnvironmentState,
          WorkerTunnelStatus as ProtocolWorkerTunnelStatus,
        } from "@openclaw/gateway-protocol";

        type Equal<Left, Right> =
          (<Value>() => Value extends Left ? 1 : 2) extends
          (<Value>() => Value extends Right ? 1 : 2) ? true : false;
        type Assert<Condition extends true> = Condition;

        type AgentCreateIsCanonical = Assert<Equal<AgentsCreateParams, ProtocolAgentsCreateParams>>;
        type AgentDeleteIsCanonical = Assert<Equal<AgentsDeleteParams, ProtocolAgentsDeleteParams>>;
        type AgentUpdateIsCanonical = Assert<Equal<AgentsUpdateParams, ProtocolAgentsUpdateParams>>;
        type GatewayArtifactIsCanonical = Assert<Equal<GatewayArtifactSummary, ProtocolArtifactSummary>>;
        type TaskIsCanonical = Assert<Equal<TaskSummary, ProtocolTaskSummary>>;
        type TaskCancelIsCanonical = Assert<Equal<TasksCancelResult, ProtocolTasksCancelResult>>;
        type TaskGetIsCanonical = Assert<Equal<TasksGetResult, ProtocolTasksGetResult>>;
        type TaskListParamsAreCanonical = Assert<Equal<TasksListParams, ProtocolTasksListParams>>;
        type TaskListIsCanonical = Assert<Equal<TasksListResult, ProtocolTasksListResult>>;
        type ToolsEffectiveIsCanonical = Assert<Equal<ToolsEffectiveParams, ProtocolToolsEffectiveParams>>;
        type WorkerMetadataIsCanonical = Assert<Equal<WorkerEnvironmentMetadata, ProtocolWorkerEnvironmentMetadata>>;
        type WorkerStateIsCanonical = Assert<Equal<WorkerEnvironmentState, ProtocolWorkerEnvironmentState>>;
        type TunnelStatusIsCanonical = Assert<Equal<WorkerTunnelStatus, ProtocolWorkerTunnelStatus>>;

        const legacyArtifact: ArtifactSummary = {
          id: "artifact-old-consumer",
          type: "file",
          sessionId: "session-old-consumer",
          createdAt: "2026-08-16T00:00:00Z",
          expiresAt: "2026-08-17T00:00:00Z",
          download: { mode: "future-delivery-mode" },
        };
        const artifactDownload: ArtifactsDownloadResult = {
          artifact: legacyArtifact,
          expiresAt: "2026-08-17T00:00:00Z",
        };
        const environment: EnvironmentSummary = {
          id: "gateway",
          type: "local",
          status: "available",
          trust: "persistent",
          desktop: true,
          issues: [{
            code: "update-required",
            action: "update-and-reconnect",
            updateCommand: "openclaw update",
            headlessReconnectCommand: "openclaw node restart",
          }],
          worker: {
            providerId: "worker-provider",
            state: "ready",
            ageMs: 1,
            attachedSessionIds: [],
            tunnelStatus: "connected",
            desktop: true,
            desktopApps: ["browser"],
          },
        };
        const environments: EnvironmentsListResult = { environments: [environment] };
        const task: TaskSummary = {
          id: "task-canonical",
          status: "completed",
          toolUseCount: 1,
          lastToolName: "read",
          deliveryStatus: "delivered",
          terminalOutcome: "succeeded",
          result: "done",
          prompt: "prove the SDK contract",
        };
        const createSession: SessionCreateParams = { attachments: [{ kind: "custom" }] };
        const sendSession: SessionSendParams = {
          key: "agent:main:external",
          message: "hello",
          attachments: [{ kind: "custom" }],
        };
        const toolParams: ToolInvokeParams = {
          sessionKey: "agent:main:external",
          args: { query: "status" },
        };
        const toolResult: ToolInvokeResult = {
          ok: false,
          toolName: "status",
          error: { message: "unavailable" },
        };

        void [
          artifactDownload,
          environments,
          task,
          createSession,
          sendSession,
          toolParams,
          toolResult,
        ];
      `);
      await consumer.run(`
        import { GatewayClientTransport, OpenClaw, normalizeGatewayEvent } from "@openclaw/sdk";

        if (typeof GatewayClientTransport !== "function") throw new Error("missing transport export");
        const event = normalizeGatewayEvent({
          event: "agent",
          payload: { runId: "packed-run", stream: "lifecycle", data: { phase: "start" } }
        });
        if (event.type !== "run.started") throw new Error("exported normalizer failed");

        const calls = [];
        let closed = false;
        const transport = {
          async request(method, params, options) {
            calls.push({ method, params, options });
            if (method === "agents.list") return { agents: [{ id: "external" }] };
            if (method === "agent.wait") {
              return { status: "ok", runId: "packed-run", sessionKey: "agent:main:external" };
            }
            if (method === "artifacts.list") {
              return { artifacts: [{ id: "artifact-packed", type: "file", title: "packed.txt" }] };
            }
            if (method === "environments.list") {
              return { environments: [{ id: "gateway", type: "local", status: "available" }] };
            }
            throw new Error(\`unexpected method: \${method}\`);
          },
          async *events() {},
          async close() {
            closed = true;
          },
        };

        const client = new OpenClaw({ transport });
        const agents = await client.agents.list();
        const run = await client.runs.wait("packed-run", { timeoutMs: 25 });
        const artifacts = await client.artifacts.list({ sessionKey: "agent:main:external" });
        const environments = await client.environments.list();
        await client.close();

        if (agents.agents[0]?.id !== "external") throw new Error("agent operation failed");
        if (run.status !== "completed") throw new Error("run result normalization failed");
        if (artifacts.artifacts[0]?.id !== "artifact-packed") {
          throw new Error("artifact operation failed");
        }
        if (environments.environments[0]?.id !== "gateway") {
          throw new Error("environment operation failed");
        }
        if (!closed) throw new Error("custom transport was not closed");
        const expectedMethods = ["agents.list", "agent.wait", "artifacts.list", "environments.list"];
        if (JSON.stringify(calls.map((call) => call.method)) !== JSON.stringify(expectedMethods)) {
          throw new Error(\`unexpected calls: \${JSON.stringify(calls)}\`);
        }
        if (calls[1]?.options?.timeoutMs !== null || calls[1]?.params?.timeoutMs !== 25) {
          throw new Error(\`run wait ownership changed: \${JSON.stringify(calls[1])}\`);
        }
      `);
    } finally {
      await consumer.cleanup();
    }
  }, 240_000);
});
