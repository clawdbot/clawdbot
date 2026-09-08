import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Value } from "typebox/value";
import { readJsonBodyWithLimit } from "../infra/http-body.js";
import {
  decodeNodeClaudeSkillInit,
  encodeNodeClaudeSkillMessage,
  NODE_CLAUDE_SKILLS_MESSAGE_BYTES,
  NODE_CLAUDE_WORKSHOP_CALL_BYTES,
  NODE_CLAUDE_WORKSHOP_RESULT_BYTES,
  NodeClaudeSkillResultSchema,
  type NodeClaudeSkillInit,
} from "../infra/node-claude-skill-protocol.js";
import { removeTemporaryArtifacts } from "../infra/temp-artifact-cleanup.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { materializeSkillResources } from "../skills/runtime/resources.js";

/** The local MCP endpoint is a transport proxy only; no library, profile, or admin access. */
export async function prepareNodeClaudeSkillSession(io: OpenClawPluginNodeHostCommandIo) {
  const frames = io.frames;
  if (!frames) {
    throw new Error("Upgrade and restart this node host for Claude skill resource support.");
  }
  const initialized = createDeferredCore<NodeClaudeSkillInit>();
  void initialized.promise.catch(() => {});
  const pending = new Map<string, ReturnType<typeof createDeferredCore<unknown>>>();
  let receivedInit = false;
  let closed = false;
  let artifacts: Awaited<ReturnType<typeof materializeSkillResources>> | undefined;
  let directory: string | undefined;
  let server: http.Server | undefined;
  const mcpServers = new Set<Server>();
  const assertCurrent = () => {
    io.signal.throwIfAborted();
    if (closed) {
      throw new Error("Claude node skill invocation closed.");
    }
  };
  const revoke = () => {
    closed = true;
    const error = new Error("Claude node skill invocation closed. Send a fresh message.");
    initialized.reject(error);
    for (const call of pending.values()) {
      call.reject(error);
    }
    pending.clear();
  };
  let unsubscribe: (() => void) | undefined;
  const close = async () => {
    revoke();
    unsubscribe?.();
    io.signal.removeEventListener("abort", revoke);
    server?.closeAllConnections();
    try {
      await Promise.all([...mcpServers].map((mcp) => mcp.close()));
    } finally {
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => {
          server!.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  };
  const cleanup = async () => {
    await artifacts?.cleanup();
    if (directory) {
      await removeTemporaryArtifacts(directory, "Node Claude skill session");
    }
  };
  try {
    io.signal.addEventListener("abort", revoke, { once: true });
    assertCurrent();
    unsubscribe = frames.onMessage((bytes) => {
      assertCurrent();
      if (!receivedInit) {
        receivedInit = true;
        initialized.resolve(decodeNodeClaudeSkillInit(bytes));
        return;
      }
      if (bytes.byteLength > NODE_CLAUDE_WORKSHOP_RESULT_BYTES) {
        throw new Error("Claude Workshop response exceeds its limit.");
      }
      const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      if (!Value.Check(NodeClaudeSkillResultSchema, value)) {
        throw new Error("Invalid Claude Workshop response.");
      }
      const call = pending.get(value.id);
      if (!call) {
        throw new Error("Claude Workshop response has no pending caller.");
      }
      pending.delete(value.id);
      call.resolve(CallToolResultSchema.parse(value.result));
    });
    const init = await initialized.promise;
    assertCurrent();
    if (init.resources) {
      artifacts = await materializeSkillResources(init.resources, assertCurrent);
      assertCurrent();
    }
    // Claude's native Read permission covers the project plus --add-dir roots.
    // Expose only verified resources, never the separate MCP configuration file.
    const argv: string[] = artifacts ? ["--add-dir", artifacts.directory] : [];
    const workshop = init.workshop;
    if (workshop) {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-claude-skills-"));
      assertCurrent();
      // An unguessable local route prevents unrelated browser traffic; the
      // Gateway's exact pending invocation remains the privileged effect owner.
      const route = `/mcp/${randomUUID()}`;
      server = http.createServer((req, res) => {
        void (async () => {
          assertCurrent();
          if (req.url !== route || req.headers.origin !== undefined || req.method !== "POST") {
            res.writeHead(404).end();
            return;
          }
          if (mcpServers.size >= 8) {
            res.writeHead(429).end();
            return;
          }
          const mcp = new Server(
            { name: "openclaw-node-skills", version: "1" },
            { capabilities: { tools: {} } },
          );
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
          mcpServers.add(mcp);
          res.once("close", () => {
            mcpServers.delete(mcp);
            void mcp.close().catch(revoke);
          });
          mcp.setRequestHandler(ListToolsRequestSchema, async () => {
            assertCurrent();
            return {
              tools: [
                {
                  name: "skill_workshop",
                  description: workshop.description,
                  inputSchema: { ...workshop.inputSchema, type: "object" as const },
                },
              ],
            };
          });
          mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
            assertCurrent();
            if (request.params.name !== "skill_workshop" || pending.size >= 8) {
              throw new Error("Only this turn's Skill Workshop is available.");
            }
            const id = randomUUID();
            const call = createDeferredCore<unknown>();
            void call.promise.catch(() => {});
            pending.set(id, call);
            try {
              await frames.send(
                encodeNodeClaudeSkillMessage(
                  { type: "workshop", id, arguments: request.params.arguments ?? {} },
                  NODE_CLAUDE_WORKSHOP_CALL_BYTES,
                ),
              );
              const result = await call.promise;
              assertCurrent();
              return CallToolResultSchema.parse(result);
            } finally {
              pending.delete(id);
            }
          });
          const body = await readJsonBodyWithLimit(req, {
            maxBytes: NODE_CLAUDE_WORKSHOP_CALL_BYTES,
            timeoutMs: 10_000,
          });
          assertCurrent();
          if (!body.ok) {
            res.writeHead(400).end();
            return;
          }
          await mcp.connect(transport);
          assertCurrent();
          await transport.handleRequest(req, res, body.value);
        })().catch(() => {
          if (!res.headersSent) {
            res.writeHead(503);
          }
          res.end();
        });
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", resolve);
      });
      assertCurrent();
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Claude node MCP listener did not publish its address.");
      }
      const configPath = path.join(directory, "mcp.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            openclaw: {
              type: "http",
              url: `http://127.0.0.1:${address.port}${route}`,
              alwaysLoad: true,
            },
          },
        }),
        { mode: 0o600, flag: "wx" },
      );
      assertCurrent();
      // Only this host-controlled tool may skip Claude's prompt. Native tools
      // retain the node's existing execution and permission policy.
      argv.push("--mcp-config", configPath, "--allowedTools", "mcp__openclaw__skill_workshop");
    }
    return {
      argv,
      catalog: artifacts?.snapshot.prompt ?? "",
      rewriteReferences: (text: string) => artifacts?.rewriteReferences(text) ?? text,
      writeStdout: async (text: string) => {
        assertCurrent();
        await frames.send(
          encodeNodeClaudeSkillMessage({ type: "stdout", text }, NODE_CLAUDE_SKILLS_MESSAGE_BYTES),
        );
      },
      close,
      cleanup,
    };
  } catch (error) {
    try {
      await close();
    } finally {
      await cleanup();
    }
    throw error;
  }
}
