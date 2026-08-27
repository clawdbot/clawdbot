import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createCoreGatewayMethodDescriptors } from "../methods/core-descriptors.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { handleGatewayRequest } from "../server-methods.js";
import { hooksStatusHandlers } from "./hooks-status.js";

const tempDirs: string[] = [];

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createHookRegistry(workspaceDir: string) {
  const registry = createEmptyPluginRegistry();
  registry.hooks.push({
    pluginId: "live-hooks",
    source: "/plugins/live-hooks/index.js",
    events: ["command:new"],
    entry: {
      hook: {
        name: "live-plugin-hook",
        description: "Registered by the live Gateway plugin registry",
        source: "openclaw-plugin",
        pluginId: "live-hooks",
        filePath: "/plugins/live-hooks/index.js",
        baseDir: "/plugins/live-hooks",
        handlerPath: "/plugins/live-hooks/index.js",
      },
      frontmatter: {},
      metadata: { events: ["command:new"] },
      invocation: { enabled: true },
    },
  });
  return {
    config: { agents: { defaults: { workspace: workspaceDir } } },
    methodRegistry: createGatewayMethodRegistry(
      createCoreGatewayMethodDescriptors(hooksStatusHandlers),
      registry,
    ),
  };
}

async function dispatchHooksStatus(params: {
  methodRegistry: ReturnType<typeof createGatewayMethodRegistry>;
  config: object;
  scopes: string[];
  requestParams?: Record<string, unknown>;
}) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: "hooks-status-test",
      method: "hooks.status",
      params: params.requestParams ?? {},
    },
    respond,
    client: {
      connId: "hooks-status-client",
      connect: {
        role: "operator",
        scopes: params.scopes,
        client: { id: "cli", version: "test", platform: "test", mode: "cli" },
        minProtocol: 1,
        maxProtocol: 1,
      },
    } as Parameters<typeof handleGatewayRequest>[0]["client"],
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => params.config,
      logGateway: { warn: vi.fn() },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
    methodRegistry: params.methodRegistry,
  });
  return respond;
}

describe("hooks.status", () => {
  it("returns typed selection-required for an ownerless explicit fleet", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-status-"));
    tempDirs.push(workspaceDir);
    const fixture = createHookRegistry(workspaceDir);
    const config = {
      ...fixture.config,
      agents: {
        ownership: "explicit",
        defaults: { workspace: workspaceDir },
        list: [{ id: "ops" }, { id: "research", workspace: workspaceDir }],
      },
    };

    const missing = await dispatchHooksStatus({
      ...fixture,
      config,
      scopes: ["operator.read"],
    });
    expect(missing).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("agent"),
      }),
    );

    const selected = await dispatchHooksStatus({
      ...fixture,
      config,
      scopes: ["operator.read"],
      requestParams: { agentId: "research" },
    });
    expect(selected).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ workspaceDir }),
      undefined,
    );
  });

  it("returns registered plugin hooks from the request-attached live registry", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-status-"));
    tempDirs.push(workspaceDir);
    const fixture = createHookRegistry(workspaceDir);
    setActivePluginRegistry(createEmptyPluginRegistry());

    const respond = await dispatchHooksStatus({
      ...fixture,
      scopes: ["operator.read"],
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        workspaceDir,
        hooks: expect.arrayContaining([
          expect.objectContaining({
            name: "live-plugin-hook",
            pluginId: "live-hooks",
            managedByPlugin: true,
          }),
        ]),
      }),
      undefined,
    );
  });

  it("requires operator.read and rejects unexpected params", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-status-"));
    tempDirs.push(workspaceDir);
    const fixture = createHookRegistry(workspaceDir);

    const denied = await dispatchHooksStatus({ ...fixture, scopes: [] });
    expect(denied).toHaveBeenCalledWith(false, undefined, {
      code: "FORBIDDEN",
      message: "missing scope: operator.read",
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.read",
        requiredScopes: ["operator.read"],
      },
    });

    const invalid = await dispatchHooksStatus({
      ...fixture,
      scopes: ["operator.read"],
      requestParams: { reload: true },
    });
    expect(invalid).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
