import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  createSessionWorkspaceProps,
  openSessionWorkspaceFile,
  renderSessionWorkspaceRail,
  toggleSessionWorkspace,
  type SessionWorkspaceHost,
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

describe("session workspace artifacts", () => {
  function createArtifactHost(params: { data: string; mimeType: string; title?: string }) {
    const handleOpenSidebar = vi.fn();
    const request = vi.fn().mockResolvedValue({
      artifact: {
        id: "artifact-1",
        mimeType: params.mimeType,
        title: params.title ?? "Unicode artifact",
      },
      data: params.data,
      encoding: "base64",
    });
    const state = {
      client: { request },
      connected: true,
      handleOpenSidebar,
      hello: gatewayHello([]),
      sessionKey: "agent:main:current",
      sessions: {},
    } as unknown as SessionWorkspaceHost;
    return { handleOpenSidebar, request, state };
  }

  it.each([
    {
      content: "Résumé 東京 🦀",
      fence: "```",
      mimeType: "text/plain",
    },
    {
      content: JSON.stringify({ message: "Résumé 東京 🦀" }),
      fence: "```json",
      mimeType: "application/json",
    },
  ])(
    "decodes UTF-8 $mimeType artifacts without corrupting visible or raw text",
    async (testCase) => {
      const data = btoa(String.fromCharCode(...new TextEncoder().encode(testCase.content)));
      const { handleOpenSidebar, state } = createArtifactHost({
        data,
        mimeType: testCase.mimeType,
      });

      createSessionWorkspaceProps(state).onOpenArtifact("artifact-1");

      await vi.waitFor(() => expect(handleOpenSidebar).toHaveBeenCalledOnce());
      expect(handleOpenSidebar.mock.calls[0]?.[0]).toEqual({
        kind: "markdown",
        content: `# Unicode artifact\n\n${testCase.fence}\n${testCase.content}\n\`\`\``,
        rawText: testCase.content,
      });
    },
  );

  it("preserves inline image artifacts as their original base64 data URLs", async () => {
    const data = "iVBORw0KGgo=";
    const { handleOpenSidebar, state } = createArtifactHost({
      data,
      mimeType: "image/png",
      title: "preview.png",
    });

    createSessionWorkspaceProps(state).onOpenArtifact("artifact-1");

    await vi.waitFor(() => expect(handleOpenSidebar).toHaveBeenCalledOnce());
    expect(handleOpenSidebar.mock.calls[0]?.[0]).toEqual({
      kind: "image",
      mimeType: "image/png",
      rawText: null,
      src: `data:image/png;base64,${data}`,
      title: "preview.png",
    });
  });

  it("reports malformed base64 artifact data as a visible workspace error", async () => {
    const { handleOpenSidebar, state } = createArtifactHost({
      data: "not-base64!",
      mimeType: "text/plain",
    });

    createSessionWorkspaceProps(state).onOpenArtifact("artifact-1");

    await vi.waitFor(() =>
      expect(createSessionWorkspaceProps(state).error).toMatch(/InvalidCharacterError|invalid/i),
    );
    expect(handleOpenSidebar).not.toHaveBeenCalled();
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

  it.each([
    { root: "/workspace", expected: "/workspace/src/readme.md" },
    { root: "C:\\workspace", expected: "C:\\workspace\\src\\readme.md" },
  ])(
    "opens rendered workspace-browser rows beneath $root with the full path",
    async ({ root, expected }) => {
      const getFile = vi.fn().mockResolvedValue({
        sessionKey: "agent:main:current",
        root,
        file: {
          path: expected,
          workspacePath: "src/readme.md",
          name: "readme.md",
          kind: "read",
          missing: false,
          content: "# Browser file\n",
        },
      });
      const listFiles = vi.fn().mockResolvedValue({
        sessionKey: "agent:main:current",
        root,
        files: [],
        browser: {
          path: "",
          entries: [{ kind: "file", name: "readme.md", path: "src/readme.md" }],
        },
      });
      const request = vi.fn().mockResolvedValue({ artifacts: [] });
      const state = {
        client: { request },
        connected: true,
        handleOpenSidebar: vi.fn(),
        hello: gatewayHello([]),
        sessionKey: "agent:main:current",
        sessions: { getFile, listFiles },
      } as unknown as SessionWorkspaceHost;

      toggleSessionWorkspace(state);
      await vi.waitFor(() => expect(listFiles).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(createSessionWorkspaceProps(state).list).not.toBeNull());

      const container = document.createElement("div");
      render(renderSessionWorkspaceRail(createSessionWorkspaceProps(state)), container);
      const row = container.querySelector<HTMLButtonElement>(
        ".chat-workspace-rail__list--browser .chat-workspace-rail__file-open",
      );
      expect(row).toBeInstanceOf(HTMLButtonElement);
      row!.click();

      await vi.waitFor(() => expect(getFile).toHaveBeenCalledOnce());
      expect(getFile.mock.calls[0]?.[1]).toBe(expected);
    },
  );

  it("opens base64 session images in the existing image sidebar", async () => {
    const handleOpenSidebar = vi.fn();
    const state = {
      client: {},
      connected: true,
      handleOpenSidebar,
      hello: gatewayHello([]),
      sessionKey: "agent:main:current",
      sessions: {
        getFile: vi.fn().mockResolvedValue({
          sessionKey: "agent:main:current",
          file: {
            path: "screenshots/result.png",
            name: "result.png",
            kind: "read",
            missing: false,
            mimeType: "image/png",
            contentEncoding: "base64",
            previewKind: "image",
            content: "iVBORw0KGgo=",
          },
        }),
      },
    } as unknown as SessionWorkspaceHost;

    openSessionWorkspaceFile(state, { path: "screenshots/result.png" });

    await vi.waitFor(() => expect(handleOpenSidebar).toHaveBeenCalledOnce());
    expect(handleOpenSidebar.mock.calls[0]?.[0]).toMatchObject({
      kind: "image",
      mimeType: "image/png",
      src: "data:image/png;base64,iVBORw0KGgo=",
      title: "result.png",
    });
  });

  it.each([
    { label: "a non-allowlisted MIME", mimeType: "image/svg+xml", contentEncoding: "base64" },
    { label: "a non-base64 encoding", mimeType: "image/png", contentEncoding: "utf8" },
  ])("rejects image preview metadata with $label", async ({ mimeType, contentEncoding }) => {
    const handleOpenSidebar = vi.fn();
    const state = {
      client: {},
      connected: true,
      handleOpenSidebar,
      hello: gatewayHello([]),
      sessionKey: "agent:main:current",
      sessions: {
        getFile: vi.fn().mockResolvedValue({
          sessionKey: "agent:main:current",
          file: {
            path: "screenshots/result.png",
            name: "result.png",
            kind: "read",
            missing: false,
            mimeType,
            contentEncoding,
            previewKind: "image",
            content: "iVBORw0KGgo=",
          },
        }),
      },
    } as unknown as SessionWorkspaceHost;

    openSessionWorkspaceFile(state, { path: "screenshots/result.png" });

    await vi.waitFor(() =>
      expect(createSessionWorkspaceProps(state).error).toBe(
        "Failed to load screenshots/result.png",
      ),
    );
    expect(handleOpenSidebar).not.toHaveBeenCalled();
  });

  it("does not render base64 content as text when the preview discriminator disagrees", async () => {
    const handleOpenSidebar = vi.fn();
    const state = {
      client: {},
      connected: true,
      handleOpenSidebar,
      hello: gatewayHello([]),
      sessionKey: "agent:main:current",
      sessions: {
        getFile: vi.fn().mockResolvedValue({
          sessionKey: "agent:main:current",
          file: {
            path: "notes.txt",
            name: "notes.txt",
            kind: "read",
            missing: false,
            contentEncoding: "base64",
            previewKind: "text",
            content: "bm90ZXM=",
          },
        }),
      },
    } as unknown as SessionWorkspaceHost;

    openSessionWorkspaceFile(state, { path: "notes.txt" });

    await vi.waitFor(() =>
      expect(createSessionWorkspaceProps(state).error).toBe("Failed to load notes.txt"),
    );
    expect(handleOpenSidebar).not.toHaveBeenCalled();
  });

  it("opens unsupported session files as metadata without treating bytes as text", async () => {
    const handleOpenSidebar = vi.fn();
    const state = {
      client: {},
      connected: true,
      handleOpenSidebar,
      hello: gatewayHello([]),
      sessionKey: "agent:main:current",
      sessions: {
        getFile: vi.fn().mockResolvedValue({
          sessionKey: "agent:main:current",
          file: {
            path: "build/cache.db",
            name: "cache.db",
            kind: "read",
            missing: false,
            mimeType: "application/x-sqlite3",
            previewKind: "unsupported",
            size: 8192,
            updatedAtMs: 1_700_000_000_000,
          },
        }),
      },
    } as unknown as SessionWorkspaceHost;

    openSessionWorkspaceFile(state, { path: "build/cache.db" });

    await vi.waitFor(() => expect(handleOpenSidebar).toHaveBeenCalledOnce());
    expect(handleOpenSidebar.mock.calls[0]?.[0]).toMatchObject({ kind: "markdown" });
    const content = handleOpenSidebar.mock.calls[0]?.[0]?.content ?? "";
    expect(content).toContain("This file is not previewable inline.");
    expect(content).toContain("application/x-sqlite3");
    expect(content).toContain("8,192 bytes");
    expect(content).toContain("2023-11-14T22:13:20.000Z");
  });

  it("keeps hostile unsupported filenames literal in metadata Markdown", async () => {
    const handleOpenSidebar = vi.fn();
    const hostilePath = " build/`\n\n![remote](https://example.com/x) report~~old~~&amp;.db ";
    const state = {
      client: {},
      connected: true,
      handleOpenSidebar,
      hello: gatewayHello([]),
      sessionKey: "agent:main:current",
      sessions: {
        getFile: vi.fn().mockResolvedValue({
          sessionKey: "agent:main:current",
          file: {
            path: hostilePath,
            name: "cache.db",
            kind: "read",
            missing: false,
            mimeType: "application/octet-stream",
            previewKind: "unsupported",
            updatedAtMs: Number.MAX_VALUE,
          },
        }),
      },
    } as unknown as SessionWorkspaceHost;

    openSessionWorkspaceFile(state, { path: hostilePath });

    await vi.waitFor(() => expect(handleOpenSidebar).toHaveBeenCalledOnce());
    const content = handleOpenSidebar.mock.calls[0]?.[0]?.content ?? "";
    expect(content).toContain(
      "``  build/`\\n\\n![remote](https://example.com/x) report~~old~~&amp;.db  ``",
    );
    expect(content).not.toContain("\n\n![remote]");
    expect(content).not.toContain("Updated:");
  });
});
