import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { TINY_PNG_BASE64, type QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  waitForHotReloadFact,
  connectHotReloadClient,
  type HotReloadConnection,
  type startHotReloadUpstreams,
} from "./gateway-config-hot-reload-fixtures.js";

type Terminal = { sessionId: string; shell: string };
export async function proveHotReloadRequests({
  gateway,
  primary,
  fixture,
  rpc,
  patch,
  verifyContinuity,
  http,
  probeMetadata,
  proveGroup,
}: {
  gateway: QaGatewayChild;
  primary: HotReloadConnection;
  fixture: Awaited<ReturnType<typeof startHotReloadUpstreams>>;
  rpc: <T>(method: string, params?: unknown) => Promise<T>;
  patch: (change: unknown, replacePaths?: string[]) => Promise<unknown>;
  verifyContinuity: (prefix: string, observation: string) => Promise<void>;
  http: (
    route: string,
    body?: unknown,
  ) => Promise<{ status: number; text: string; headers: Headers }>;
  probeMetadata: (phase: string) => Promise<void>;
  proveGroup: (prefix: string, run: () => Promise<void>) => Promise<void>;
}) {
  const SESSION_KEY = "agent:qa:main";
  const terminalIds: string[] = [];
  const terminalMarker = async (terminal: Terminal, marker: string) => {
    const cursor = primary.events.length;
    // Split the marker in shell input so an echoed command cannot satisfy the output proof.
    await rpc("terminal.input", {
      sessionId: terminal.sessionId,
      data: `printf '%s%s=%s\\n' '${marker.slice(0, 4)}' '${marker.slice(4)}' "$0"\n`,
    });
    await waitForHotReloadFact("PTY command output", () => {
      const output = primary.events
        .slice(cursor)
        .flatMap((event) => {
          const payload = event.payload as { sessionId?: string; data?: string } | undefined;
          return event.event === "terminal.data" && payload?.sessionId === terminal.sessionId
            ? [payload.data ?? ""]
            : [];
        })
        .join("");
      return output.includes(`${marker}=${terminal.shell}`) ? true : undefined;
    });
  };
  // Exercise expiry before the shared writer reaches its per-minute config budget.
  await proveGroup("gateway.terminal.detachedSessionTimeoutSeconds", async () => {
    const sessions = async () =>
      (await rpc<{ sessions: Array<{ sessionId: string; attached: boolean }> }>("terminal.list"))
        .sessions;
    const openDetached = async () => {
      const connection = await connectHotReloadClient(gateway);
      try {
        const terminal = await connection.client.request<Terminal>("terminal.open", {
          agentId: "qa",
          cols: 80,
          rows: 24,
        });
        terminalIds.push(terminal.sessionId);
        return terminal;
      } finally {
        await connection.client.stopAndWait({ timeoutMs: 2_000 });
      }
    };
    await patch({ gateway: { terminal: { detachedSessionTimeoutSeconds: 30 } } });
    const expired = await openDetached();
    await waitForHotReloadFact("terminal detached", async () =>
      (await sessions()).some((item) => item.sessionId === expired.sessionId && !item.attached)
        ? true
        : undefined,
    );
    await delay(2_100);
    await patch({ gateway: { terminal: { detachedSessionTimeoutSeconds: 1 } } });
    assert(
      !(await sessions()).some((item) => item.sessionId === expired.sessionId),
      "Shortened timeout must use the original detach time and reap before acknowledging reload",
    );
    await assert.rejects(
      rpc("terminal.attach", { sessionId: expired.sessionId }),
      /unknown terminal/,
    );

    await patch({ gateway: { terminal: { detachedSessionTimeoutSeconds: 5 } } });
    const extended = await openDetached();
    await patch({ gateway: { terminal: { detachedSessionTimeoutSeconds: 15 } } });
    await delay(5_100);
    await rpc("terminal.attach", { sessionId: extended.sessionId });
    await terminalMarker(extended, "EXTENDED_TERMINAL_ALIVE");
    await patch({ gateway: { terminal: { detachedSessionTimeoutSeconds: 0 } } });
    await terminalMarker(extended, "ATTACHED_TERMINAL_ALIVE");
    const immediate = await openDetached();
    await waitForHotReloadFact("zero-timeout terminal closed", async () =>
      !(await sessions()).some((item) => item.sessionId === immediate.sessionId) ? true : undefined,
    );
    await rpc("terminal.close", { sessionId: extended.sessionId });
    await patch({ gateway: { terminal: { detachedSessionTimeoutSeconds: 300 } } });
    await verifyContinuity(
      "gateway.terminal.detachedSessionTimeoutSeconds",
      "A real detached PTY expired from its original disconnect time; extending retained its shell past the old deadline; attached PTYs survived zero timeout and new disconnects closed immediately",
    );
  });

  await proveGroup("gateway.http.endpoints", async () => {
    await patch({
      gateway: {
        http: { endpoints: { chatCompletions: { enabled: false }, responses: { enabled: false } } },
      },
    });
    for (const endpoint of ["chatCompletions", "responses"] as const) {
      const route = endpoint === "chatCompletions" ? "/v1/chat/completions" : "/v1/responses";
      for (const enabled of [false, true, false]) {
        await patch({ gateway: { http: { endpoints: { [endpoint]: { enabled } } } } });
        assert.equal((await http(route)).status, enabled ? 405 : 404);
        assert.equal((await http("/v1/models")).status, enabled ? 200 : 404);
        assert.equal((await http("/v1/embeddings")).status, enabled ? 405 : 404);
      }
      await patch({ gateway: { http: { endpoints: { [endpoint]: { enabled: true } } } } });
      const image =
        endpoint === "chatCompletions"
          ? { type: "image_url", image_url: { url: `data:image/png;base64,${TINY_PNG_BASE64}` } }
          : {
              type: "input_image",
              source: { type: "base64", media_type: "image/png", data: TINY_PNG_BASE64 },
            };
      const body =
        endpoint === "chatCompletions"
          ? {
              model: "openclaw/qa",
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: "Reply exactly `IMAGE_ACCEPTED`" }, image],
                },
              ],
            }
          : {
              model: "openclaw/qa",
              input: [
                {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: "Reply exactly `IMAGE_ACCEPTED`" }, image],
                },
              ],
            };
      for (const maxBytes of [1, 1024, 1]) {
        await patch({
          gateway: { http: { endpoints: { [endpoint]: { images: { maxBytes } } } } },
        });
        if (endpoint === "chatCompletions" && maxBytes > 1) {
          await probeMetadata("before-first-model-response");
        }
        const response = await http(route, body);
        assert.equal(response.status, maxBytes === 1 ? 400 : 200, response.text);
        if (maxBytes > 1) {
          assert(response.text.includes("IMAGE_ACCEPTED"));
          if (endpoint === "chatCompletions") {
            await probeMetadata("after-first-model-response");
          }
        }
      }
      await patch({ gateway: { http: { endpoints: { [endpoint]: { enabled: false } } } } });
    }
    await verifyContinuity(
      "gateway.http.endpoints",
      "Both APIs and shared routes toggled; real image requests changed 400/200/400",
    );
  });

  await proveGroup("gateway.tools", async () => {
    const invokeAgents = () =>
      http("/tools/invoke", { tool: "agents_list", args: {}, sessionKey: SESSION_KEY });
    await patch({ gateway: { tools: { deny: [] } } }, ["gateway.tools.deny"]);
    const baselineAgents = await invokeAgents();
    assert.equal(baselineAgents.status, 200, baselineAgents.text);
    assert(
      baselineAgents.text.includes('"qa"'),
      "Tool execution must list the configured QA agent",
    );
    for (const denied of [true, false, true]) {
      await patch({ gateway: { tools: { deny: denied ? ["agents_list"] : [] } } }, [
        "gateway.tools.deny",
      ]);
      const response = await http("/tools/invoke", {
        tool: "agents_list",
        args: {},
        sessionKey: SESSION_KEY,
      });
      assert.equal(response.status, denied ? 404 : 200, response.text);
    }
    await verifyContinuity(
      "gateway.tools",
      "Direct tool execution changed unavailable/allowed/unavailable",
    );
  });

  await proveGroup("gateway.cliAgents", async () => {
    const catalog = await rpc<{
      catalogs: Array<{ id: string; capabilities: { startTerminal?: boolean } }>;
    }>("sessions.catalog.list", { agentId: "qa" });
    assert(
      catalog.catalogs.some(
        (item) => item.id === "qa-hot-reload-shell" && item.capabilities.startTerminal,
      ),
      "Synthetic CLI catalog must be registered before its hot policy proof",
    );
    for (const enabled of [false, true, false]) {
      await patch({ gateway: { cliAgents: { enabled } } });
      const operation = rpc<Terminal>("sessions.catalog.startTerminal", {
        catalogId: "qa-hot-reload-shell",
        agentId: "qa",
        cwd: gateway.workspaceDir,
      });
      if (!enabled) {
        await assert.rejects(operation, /CLI agent terminal start is disabled/);
      } else {
        const terminal = await operation;
        terminalIds.push(terminal.sessionId);
        await terminalMarker(terminal, "CLI_CATALOG_EXECUTED");
      }
    }
    await verifyContinuity(
      "gateway.cliAgents",
      "Synthetic CLI catalog blocked, launched a real PTY, then blocked again",
    );
  });
  await proveGroup("gateway.terminal.shell", async () => {
    await patch({ gateway: { terminal: { shell: "/bin/sh" } } });
    const retained = await rpc<Terminal>("terminal.open", { agentId: "qa", cols: 80, rows: 24 });
    terminalIds.push(retained.sessionId);
    assert.equal(retained.shell, "/bin/sh");
    await patch({ gateway: { terminal: { shell: "/bin/bash" } } });
    await terminalMarker(retained, "RETAINED_SHELL_ALIVE");
    const replacement = await rpc<Terminal>("terminal.open", {
      agentId: "qa",
      cols: 80,
      rows: 24,
    });
    terminalIds.push(replacement.sessionId);
    assert.equal(replacement.shell, "/bin/bash");
    await terminalMarker(replacement, "NEW_SHELL_ALIVE");
    await patch({ gateway: { terminal: { shell: null } } });
    const defaultShell = await rpc<Terminal>("terminal.open", {
      agentId: "qa",
      cols: 80,
      rows: 24,
    });
    terminalIds.push(defaultShell.sessionId);
    assert.equal(defaultShell.shell, "/bin/sh");
    await terminalMarker(defaultShell, "DEFAULT_SHELL_ALIVE");
    await terminalMarker(retained, "RETAINED_AFTER_DELETION");
    for (const sessionId of terminalIds) {
      await rpc("terminal.close", { sessionId });
    }
    await verifyContinuity(
      "gateway.terminal.shell",
      "Existing sh PTY survived; new PTYs used bash then default sh after deletion",
    );
  });

  await proveGroup("gateway.http.securityHeaders.strictTransportSecurity", async () => {
    for (const value of ["max-age=60", "max-age=120; includeSubDomains", false]) {
      await patch({ gateway: { http: { securityHeaders: { strictTransportSecurity: value } } } });
      assert.equal(
        (await http("/healthz")).headers.get("strict-transport-security"),
        value || null,
      );
      assert.equal(
        (await http("/v1/models")).headers.get("strict-transport-security"),
        value || null,
      );
    }
    await verifyContinuity(
      "gateway.http.securityHeaders.strictTransportSecurity",
      "Fresh probe and API responses changed HSTS and then removed it",
    );
  });

  await proveGroup("gateway.controlUi.github", async () => {
    for (const generation of [0, 1]) {
      await patch({
        gateway: { controlUi: { github: { token: fixture.githubTokens[generation] } } },
      });
      const result = await rpc<{ title: string }>("controlUi.githubPreview", {
        kind: "issue",
        owner: "qa",
        repo: "reload",
        number: 1,
      });
      assert.equal(result.title, `Fixture credential generation ${generation}`);
      assert(fixture.githubRequests.includes(generation));
    }
    await verifyContinuity(
      "gateway.controlUi.github",
      "The same preview used each updated generated credential at the simulated GitHub upstream",
    );
  });
}
