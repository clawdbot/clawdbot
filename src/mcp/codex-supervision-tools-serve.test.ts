// Codex supervision MCP tests cover the retired Supervisor command bridge.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  createCodexSupervisionToolsMcpServer,
  serveCodexSupervisionToolsMcp,
} from "./codex-supervision-tools-serve.js";

type EnsureStandalonePluginToolRegistryLoaded =
  typeof import("../plugins/tools.js").ensureStandalonePluginToolRegistryLoaded;
type ConnectToolsMcpServerToStdio =
  typeof import("./tools-stdio-server.js").connectToolsMcpServerToStdio;

const ensureStandalonePluginToolRegistryLoadedMock = vi.hoisted(() =>
  vi.fn<EnsureStandalonePluginToolRegistryLoaded>(() => undefined),
);
const resolvePluginToolsMock = vi.hoisted(() => vi.fn<() => AnyAgentTool[]>(() => []));
const connectToolsMcpServerToStdioMock = vi.hoisted(() =>
  vi.fn<ConnectToolsMcpServerToStdio>(async () => {}),
);
const disposeRegisteredAgentHarnessesMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../agents/harness/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/harness/registry.js")>();
  return { ...actual, disposeRegisteredAgentHarnesses: disposeRegisteredAgentHarnessesMock };
});

vi.mock("../plugins/tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/tools.js")>();
  return {
    ...actual,
    ensureStandalonePluginToolRegistryLoaded: ensureStandalonePluginToolRegistryLoadedMock,
    resolvePluginTools: resolvePluginToolsMock,
  };
});

vi.mock("./tools-stdio-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools-stdio-server.js")>();
  return { ...actual, connectToolsMcpServerToStdio: connectToolsMcpServerToStdioMock };
});

const TOOL_NAMES = [
  "codex_endpoint_probe",
  "codex_sessions_list",
  "codex_session_read",
  "codex_session_send",
  "codex_session_interrupt",
] as const;

function createTools(): AnyAgentTool[] {
  return TOOL_NAMES.map(
    (name) =>
      ({
        name,
        label: name,
        description: name,
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      }) as unknown as AnyAgentTool,
  );
}

describe("createCodexSupervisionToolsMcpServer", () => {
  beforeEach(() => {
    ensureStandalonePluginToolRegistryLoadedMock.mockClear();
    resolvePluginToolsMock.mockReset();
    resolvePluginToolsMock.mockReturnValue([]);
    connectToolsMcpServerToStdioMock.mockClear();
    disposeRegisteredAgentHarnessesMock.mockClear();
  });

  it("fails closed when the external Codex plugin tools are unavailable", () => {
    expect(() =>
      createCodexSupervisionToolsMcpServer({
        config: {},
        tools: [],
      }),
    ).toThrow("Install or update @openclaw/codex");
  });

  it("lists official tools through the trusted standalone owner context", async () => {
    resolvePluginToolsMock.mockReturnValue(createTools());
    const server = createCodexSupervisionToolsMcpServer({ config: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "codex-supervision-owner-test", version: "0.0.0" },
      { capabilities: {} },
    );

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
      expect(ensureStandalonePluginToolRegistryLoadedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({ senderIsOwner: true }),
        }),
      );
      expect(resolvePluginToolsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({ senderIsOwner: true }),
        }),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("preserves normalized Codex endpoint config while forcing bridge activation", () => {
    resolvePluginToolsMock.mockReturnValue(createTools());

    createCodexSupervisionToolsMcpServer({
      config: {
        plugins: {
          allow: [" CODEX "],
          deny: ["CoDeX"],
          entries: {
            " CODEX ": {
              config: {
                appServer: { transport: "websocket", url: "ws://127.0.0.1:4500" },
                supervision: { enabled: false },
              },
            },
          },
        },
      },
    });

    const context = ensureStandalonePluginToolRegistryLoadedMock.mock.calls[0]?.[0]?.context;
    expect(context?.config?.plugins).toMatchObject({
      allow: ["codex"],
      deny: [],
      entries: {
        codex: {
          enabled: true,
          config: {
            appServer: { transport: "websocket", url: "ws://127.0.0.1:4500" },
            supervision: { enabled: true },
          },
        },
      },
    });
    expect(context?.config?.plugins?.entries).not.toHaveProperty(" CODEX ");
  });

  it("disposes the Codex harness when the stdio bridge shuts down", async () => {
    resolvePluginToolsMock.mockReturnValue(createTools());

    await serveCodexSupervisionToolsMcp();

    const shutdown = connectToolsMcpServerToStdioMock.mock.calls[0]?.[1]?.onShutdown;
    expect(shutdown).toBe(disposeRegisteredAgentHarnessesMock);
    await shutdown?.();
    expect(disposeRegisteredAgentHarnessesMock).toHaveBeenCalledOnce();
  });
});
