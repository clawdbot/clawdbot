import { describe, expect, it, vi } from "vitest";
import {
  createSessionWorkspaceProps,
  openSessionWorkspaceFile,
  toggleSessionWorkspace,
  type SessionWorkspaceHost,
  workspaceBrowserFilePath,
} from "./chat-session-workspace.ts";

function gatewayHello(methods: string[], scopes = ["operator.admin"]) {
  return {
    type: "hello-ok" as const,
    protocol: 3,
    auth: { role: "operator", scopes },
    features: { methods },
  };
}

describe("toggleSessionWorkspace", () => {
  it("expands and collapses the session workspace rail", () => {
    const requestUpdate = vi.fn();
    const state = {
      client: null,
      connected: false,
      handleOpenSidebar: vi.fn(),
      hello: null,
      requestUpdate,
      sessionKey: "agent:main:current",
      sessions: {},
    } as unknown as SessionWorkspaceHost;

    expect(createSessionWorkspaceProps(state).collapsed).toBe(true);

    toggleSessionWorkspace(state);

    expect(createSessionWorkspaceProps(state).collapsed).toBe(false);

    toggleSessionWorkspace(state);

    expect(createSessionWorkspaceProps(state).collapsed).toBe(true);
    expect(requestUpdate).toHaveBeenCalledTimes(2);
  });
});

describe("workspaceBrowserFilePath", () => {
  it("resolves browser rows from the workspace root", () => {
    expect(workspaceBrowserFilePath("/workspace", "src/readme.md")).toBe(
      "/workspace/src/readme.md",
    );
  });

  it("preserves Windows workspace separators", () => {
    expect(workspaceBrowserFilePath("C:\\workspace", "src/readme.md")).toBe(
      "C:\\workspace\\src\\readme.md",
    );
  });

  it("preserves the POSIX filesystem root", () => {
    expect(workspaceBrowserFilePath("/", "src/readme.md")).toBe("/src/readme.md");
  });
});

describe("openSessionWorkspaceFile", () => {
  it("opens Markdown with a canonical Gateway- and pane-scoped draft identity", async () => {
    const handleOpenSidebar = vi.fn();
    const getFile = vi.fn().mockResolvedValue({
      sessionKey: "agent:main:current",
      root: "/workspace",
      file: {
        path: "README.md",
        workspacePath: "README.md",
        name: "README.md",
        kind: "read",
        missing: false,
        content: "# Before\n",
        hash: "a".repeat(64),
      },
    });
    const state = {
      client: {},
      connected: true,
      handleOpenSidebar,
      hello: gatewayHello(["sessions.files.set"]),
      sessionKey: "agent:main:current",
      sessionWorkspaceDraftScope: "pane-left",
      settings: { gatewayUrl: "wss://gateway-a.example" },
      sessions: { getFile },
    } as unknown as SessionWorkspaceHost;

    openSessionWorkspaceFile(state, { path: "readme.md" });

    await vi.waitFor(() => expect(handleOpenSidebar).toHaveBeenCalledOnce());
    expect(handleOpenSidebar.mock.calls[0]?.[0]).toMatchObject({
      kind: "file",
      name: "README.md",
      content: "# Before\n",
      draftKey:
        "wss://gateway-a.example\u0000pane-left\u0000agent:main:current\u0000/workspace\u0000README.md",
      edit: { hash: "a".repeat(64) },
    });
  });

  it.each([
    { label: "the method is not advertised", methods: [], scopes: ["operator.admin"] },
    {
      label: "the connection lacks admin scope",
      methods: ["sessions.files.set"],
      scopes: ["operator.read"],
    },
  ])("keeps Markdown read-only when $label", async ({ methods, scopes }) => {
    const handleOpenSidebar = vi.fn();
    const state = {
      client: {},
      connected: true,
      handleOpenSidebar,
      hello: gatewayHello(methods, scopes),
      sessionKey: "agent:main:current",
      sessions: {
        getFile: vi.fn().mockResolvedValue({
          sessionKey: "agent:main:current",
          file: {
            path: "README.md",
            name: "README.md",
            kind: "read",
            missing: false,
            content: "# Before\n",
            hash: "a".repeat(64),
          },
        }),
      },
    } as unknown as SessionWorkspaceHost;

    openSessionWorkspaceFile(state, { path: "README.md" });

    await vi.waitFor(() => expect(handleOpenSidebar).toHaveBeenCalledOnce());
    expect(handleOpenSidebar.mock.calls[0]?.[0]).toMatchObject({ kind: "file" });
    expect(handleOpenSidebar.mock.calls[0]?.[0]?.edit).toBeUndefined();
  });
});
