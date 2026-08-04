// Scenario-owned proof for the source-internal preview App SDK package boundary.
import { describe, it } from "vitest";
import { createPackedSdkConsumer } from "./package.e2e.test-support.js";

describe("external preview App SDK boundary", () => {
  it("packs an external consumer that uses only the exported entrypoint and a custom transport", async () => {
    const consumer = await createPackedSdkConsumer();
    try {
      await consumer.run(`
        import { OpenClaw, normalizeGatewayEvent } from "@openclaw/sdk";

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
