import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  createSessionWorkspaceProps,
  isSessionWorkspaceItemLoading,
  openSessionWorkspaceFile,
  refreshSessionWorkspace,
  renderSessionWorkspaceRail,
  revealSessionWorkspaceFile,
  resolveSessionDiffSidebarContent,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";
import type { SidebarContent } from "./chat-sidebar.ts";

async function loadedSidebarContent(
  handleOpenSidebar: ReturnType<typeof vi.fn>,
): Promise<SidebarContent> {
  await vi.waitFor(() => expect(handleOpenSidebar).toHaveBeenCalledTimes(2));
  expect(handleOpenSidebar.mock.calls[0]?.[0]).toBeNull();
  return handleOpenSidebar.mock.calls[1]?.[0] as SidebarContent;
}

function gatewayHello(methods: string[], scopes = ["operator.admin"]) {
  return {
    type: "hello-ok" as const,
    protocol: 3,
    auth: { role: "operator", scopes },
    features: { methods },
  };
}

describe("session workspace state", () => {
  it("carries the saved bottom dock across session workspace state", () => {
    const state = {
      client: null,
      connected: false,
      handleOpenSidebar: vi.fn(),
      hello: null,
      requestUpdate: vi.fn(),
      sessionKey: "agent:main:current",
      settings: { chatWorkspaceDock: "bottom" },
      sidebarContent: null,
      sessions: {},
    } as unknown as SessionWorkspaceHost;

    const workspace = createSessionWorkspaceProps(state);
    expect(workspace.dock).toBe("bottom");

    workspace.onSetDock("right");
    expect(createSessionWorkspaceProps(state).dock).toBe("right");
    expect(state.settings?.chatWorkspaceDock).toBe("right");
  });

  it("shows the Files skeleton only while a slow cloud workspace request is pending", async () => {
    let resolveList!: (value: {
      sessionKey: string;
      root: string;
      files: Array<{ kind: "modified"; name: string; path: string; missing: false }>;
    }) => void;
    const listFiles = vi.fn(
      () =>
        new Promise<{
          sessionKey: string;
          root: string;
          files: Array<{ kind: "modified"; name: string; path: string; missing: false }>;
        }>((resolve) => {
          resolveList = resolve;
        }),
    );
    const state = {
      client: { request: vi.fn().mockResolvedValue({ artifacts: [] }) },
      connected: true,
      connectionEpoch: 1,
      handleOpenSidebar: vi.fn(),
      hello: null,
      agentsList: { agents: [] },
      requestUpdate: vi.fn(),
      sessionKey: "agent:main:cloud",
      sidebarContent: null,
      sessions: { listFiles },
    } as unknown as SessionWorkspaceHost;
    const mount = document.createElement("div");

    render(
      renderSessionWorkspaceRail(createSessionWorkspaceProps(state, { expanded: true }), {
        embedded: true,
      }),
      mount,
    );

    expect(listFiles).toHaveBeenCalledOnce();
    const skeleton = mount.querySelector<HTMLElement & { variant: string }>(
      "openclaw-panel-loading-skeleton",
    );
    expect(skeleton).not.toBeNull();
    expect(skeleton?.variant).toBe("files");
    expect(mount.textContent).not.toContain("Loading session workspace");

    resolveList({
      sessionKey: state.sessionKey,
      root: "/workspace/cloud",
      files: [{ kind: "modified", name: "slow.ts", path: "src/slow.ts", missing: false }],
    });
    await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
    render(
      renderSessionWorkspaceRail(createSessionWorkspaceProps(state, { expanded: true }), {
        embedded: true,
      }),
      mount,
    );

    expect(mount.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
    expect(mount.textContent).toContain("src/slow.ts");
  });

  it("rotates Files and Review ownership across a same-client reconnect", async () => {
    let resolveReplacementList!: (value: {
      sessionKey: string;
      root: string;
      gitCheckout: boolean;
      files: [];
    }) => void;
    const replacementList = new Promise<{
      sessionKey: string;
      root: string;
      gitCheckout: boolean;
      files: [];
    }>((resolve) => {
      resolveReplacementList = resolve;
    });
    let resolveOldFile!: (value: {
      sessionKey: string;
      root: string;
      file: { path: string; name: string; kind: "read"; missing: false; content: string };
    }) => void;
    const oldFile = new Promise<{
      sessionKey: string;
      root: string;
      file: { path: string; name: string; kind: "read"; missing: false; content: string };
    }>((resolve) => {
      resolveOldFile = resolve;
    });
    const listFiles = vi
      .fn()
      .mockResolvedValueOnce({
        sessionKey: "agent:main:current",
        root: "/checkout/a",
        gitCheckout: true,
        files: [],
      })
      .mockReturnValueOnce(replacementList);
    const getFile = vi.fn().mockReturnValue(oldFile);
    const client = { request: vi.fn().mockResolvedValue({ artifacts: [] }) };
    const state = {
      client,
      connected: true,
      connectionEpoch: 1,
      handleOpenSidebar: vi.fn(),
      hello: gatewayHello(["sessions.diff"]),
      agentsList: { agents: [] },
      requestUpdate: vi.fn(),
      sessionKey: "agent:main:current",
      sidebarContent: null,
      sessions: { getFile, listFiles },
    } as unknown as SessionWorkspaceHost;
    const handleOpenSidebar = vi.fn((content: SidebarContent | null) => {
      state.sidebarContent = content;
    });
    state.handleOpenSidebar = handleOpenSidebar;

    createSessionWorkspaceProps(state, { expanded: true });
    await vi.waitFor(() =>
      expect(createSessionWorkspaceProps(state).list?.root).toBe("/checkout/a"),
    );
    const oldDiff = resolveSessionDiffSidebarContent(state);
    expect(oldDiff?.kind).toBe("session-diff");
    createSessionWorkspaceProps(state, { expanded: true }).onOpenDiff?.();
    expect(state.sidebarContent).toBe(oldDiff);
    openSessionWorkspaceFile(state, { path: "README.md" });
    expect(handleOpenSidebar).toHaveBeenLastCalledWith(null);

    (state as SessionWorkspaceHost & { connectionEpoch: number }).connectionEpoch = 2;
    const pending = createSessionWorkspaceProps(state, { expanded: true });

    expect(pending.list).toBeNull();
    expect(pending.onOpenDiff).toBeTypeOf("function");
    expect(listFiles).toHaveBeenCalledTimes(2);
    expect(state.sidebarContent).toBeNull();

    resolveOldFile({
      sessionKey: "agent:main:current",
      root: "/checkout/a",
      file: {
        path: "README.md",
        name: "README.md",
        kind: "read",
        missing: false,
        content: "old checkout",
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(handleOpenSidebar).toHaveBeenCalledTimes(2);

    resolveReplacementList({
      sessionKey: "agent:main:current",
      root: "/checkout/b",
      gitCheckout: true,
      files: [],
    });
    await vi.waitFor(() =>
      expect(createSessionWorkspaceProps(state).list?.root).toBe("/checkout/b"),
    );
    expect(resolveSessionDiffSidebarContent(state)).not.toBe(oldDiff);
  });

  it("refreshes content in place while rotating an open default Review loader", async () => {
    let resolveRefresh!: (value: unknown) => void;
    const listFiles = vi
      .fn()
      .mockResolvedValueOnce({
        sessionKey: "agent:main:current",
        root: "/checkout/a",
        gitCheckout: true,
        files: [],
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
      );
    const state = {
      client: { request: vi.fn().mockResolvedValue({ artifacts: [] }) } as never,
      connected: true,
      connectionEpoch: 1,
      handleOpenSidebar: vi.fn(),
      hello: gatewayHello(["sessions.diff"]),
      agentsList: { agents: [] },
      requestUpdate: vi.fn(),
      sessionKey: "agent:main:current",
      sidebarContent: null,
      sessions: { listFiles } as never,
    } as SessionWorkspaceHost;
    state.handleOpenSidebar = (content) => {
      state.sidebarContent = content;
    };
    createSessionWorkspaceProps(state, { expanded: true });
    await vi.waitFor(() => expect(createSessionWorkspaceProps(state).list).not.toBeNull());
    const oldDiff = resolveSessionDiffSidebarContent(state)!;
    createSessionWorkspaceProps(state, { expanded: true }).onOpenDiff?.();

    refreshSessionWorkspace(state, true);

    expect(createSessionWorkspaceProps(state).list?.root).toBe("/checkout/a");
    expect(state.sidebarContent).toMatchObject({ kind: "session-diff" });
    expect(state.sidebarContent).not.toBe(oldDiff);
    expect(listFiles).toHaveBeenCalledTimes(2);
    resolveRefresh({ sessionKey: state.sessionKey, files: [] });
  });

  it("retries a pending visible reload after the previous load failed", async () => {
    let rejectInitialLoad!: (error: Error) => void;
    const initialLoad = new Promise((_, reject) => {
      rejectInitialLoad = reject;
    });
    const listFiles = vi
      .fn()
      .mockReturnValueOnce(initialLoad)
      .mockResolvedValueOnce({ sessionKey: "agent:main:current", files: [] });
    const state = {
      client: { request: vi.fn().mockResolvedValue({ artifacts: [] }) } as never,
      connected: true,
      connectionEpoch: 1,
      handleOpenSidebar: vi.fn(),
      hello: null,
      agentsList: { agents: [] },
      requestUpdate: vi.fn(),
      sessionKey: "agent:main:current",
      sidebarContent: null,
      sessions: { listFiles } as never,
    } as SessionWorkspaceHost;

    createSessionWorkspaceProps(state, { expanded: true });
    expect(listFiles).toHaveBeenCalledTimes(1);
    refreshSessionWorkspace(state, true);
    rejectInitialLoad(new Error("temporary failure"));
    await vi.waitFor(() =>
      expect(createSessionWorkspaceProps(state).error).toContain("temporary failure"),
    );

    createSessionWorkspaceProps(state, { expanded: true });

    await vi.waitFor(() => expect(createSessionWorkspaceProps(state).list).not.toBeNull());
    expect(listFiles).toHaveBeenCalledTimes(2);
    expect(createSessionWorkspaceProps(state).error).toBeNull();
  });

  it.each([
    { label: "Files is closed or inactive", options: { expanded: false }, terminal: true },
    {
      label: "the chat pane is hidden before its pending search runs",
      options: { expanded: true, presented: false },
      terminal: false,
    },
  ])("keeps a revealed workspace cold when $label", async ({ options, terminal }) => {
    vi.useFakeTimers();
    try {
      const listFiles = vi.fn().mockResolvedValue({
        sessionKey: "agent:main:current",
        files: [],
      });
      const state = {
        client: { request: vi.fn().mockResolvedValue({ artifacts: [] }) } as never,
        connected: true,
        connectionEpoch: 1,
        handleOpenSidebar: vi.fn(),
        hello: null,
        agentsList: { agents: [] },
        requestUpdate: vi.fn(),
        sessionKey: "agent:main:current",
        sidebarContent: null,
        sessions: { listFiles } as never,
      } as SessionWorkspaceHost;

      createSessionWorkspaceProps(state, { expanded: true });
      await vi.advanceTimersByTimeAsync(0);
      revealSessionWorkspaceFile(state, "src/README.md");
      await vi.advanceTimersByTimeAsync(0);
      expect(listFiles).toHaveBeenCalledTimes(2);

      createSessionWorkspaceProps(state, { expanded: true }).onSearch("hidden");
      if (terminal) {
        refreshSessionWorkspace(state, false);
      }
      createSessionWorkspaceProps(state, options);

      expect(listFiles).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(160);
      expect(listFiles).toHaveBeenCalledTimes(2);

      createSessionWorkspaceProps(state, { expanded: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(listFiles).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
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
      sidebarContent: null,
      sessions: {},
    } as unknown as SessionWorkspaceHost;
    return { handleOpenSidebar, request, state };
  }

  it("keeps nested code literal in a decoded text artifact preview", async () => {
    const source = [
      "Résumé 東京 🦀",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "**literal after**",
    ].join("\n");
    const { handleOpenSidebar, state } = createArtifactHost({
      data: btoa(String.fromCharCode(...new TextEncoder().encode(source))),
      mimeType: "text/markdown",
      title: "Source notes",
    });
    createSessionWorkspaceProps(state).onOpenArtifact("artifact-1");
    const content = await loadedSidebarContent(handleOpenSidebar);
    expect(content).toMatchObject({ kind: "markdown", rawText: source });
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: SidebarContent;
      updateComplete: Promise<unknown>;
    };
    panel.content = content;
    document.body.append(panel);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const schedule = vi.spyOn(globalThis, "setTimeout");
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      await panel.updateComplete;
      const reader = panel.querySelector(".sidebar-markdown-reader");
      expect(reader?.querySelector("h1")?.textContent).toBe("Source notes");
      expect.soft(reader?.querySelectorAll("pre code")).toHaveLength(1);
      expect.soft(reader?.querySelector("pre code")?.textContent).toBe(`${source}\n`);
      expect.soft(reader?.querySelector("strong")).toBeNull();
      const copyButton = reader?.querySelector<HTMLButtonElement>(".code-block-copy");
      expect(copyButton).toBeInstanceOf(HTMLButtonElement);
      copyButton!.click();
      await vi.waitFor(() => expect(copyButton!.getAttribute("aria-label")).toBe("Copied!"));
      expect(writeText).toHaveBeenCalledWith(source);
    } finally {
      for (const [index, [, delay]] of schedule.mock.calls.entries()) {
        if (delay === 1_500) {
          globalThis.clearTimeout(schedule.mock.results[index]?.value);
        }
      }
      schedule.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
      panel.remove();
    }
  });

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

      expect(await loadedSidebarContent(handleOpenSidebar)).toEqual({
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

    expect(await loadedSidebarContent(handleOpenSidebar)).toEqual({
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
    expect(handleOpenSidebar).toHaveBeenCalledOnce();
    expect(handleOpenSidebar).toHaveBeenCalledWith(null);
  });
});

describe("openSessionWorkspaceFile", () => {
  it.each([
    { client: null, connected: true, label: "no Gateway client exists" },
    { client: {}, connected: false, label: "the Gateway is disconnected" },
  ])("preserves existing Review content when $label", ({ client, connected }) => {
    const existingContent = {
      kind: "markdown",
      content: "Existing review",
      rawText: "Existing review",
    } satisfies SidebarContent;
    let sidebarContent: SidebarContent | null = existingContent;
    const handleOpenSidebar = vi.fn((content: SidebarContent | null) => {
      sidebarContent = content;
    });
    const getFile = vi.fn();
    const state = {
      client,
      connected,
      handleOpenSidebar,
      hello: gatewayHello([]),
      sessionKey: "agent:main:current",
      sidebarContent: existingContent,
      sessions: { getFile },
    } as unknown as SessionWorkspaceHost;

    openSessionWorkspaceFile(state, { path: "README.md" });

    expect(getFile).not.toHaveBeenCalled();
    expect(handleOpenSidebar).not.toHaveBeenCalled();
    expect(sidebarContent).toBe(existingContent);
    expect(isSessionWorkspaceItemLoading(state)).toBe(false);
  });

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
      sidebarContent: null,
      sessions: { getFile },
    } as unknown as SessionWorkspaceHost;

    openSessionWorkspaceFile(state, { path: "readme.md" });

    expect(isSessionWorkspaceItemLoading(state)).toBe(true);
    expect(await loadedSidebarContent(handleOpenSidebar)).toMatchObject({
      kind: "file",
      name: "README.md",
      content: "# Before\n",
      draftKey:
        "wss://gateway-a.example\u0000pane-left\u0000agent:main:current\u0000/workspace\u0000README.md",
      edit: { hash: "a".repeat(64) },
    });
    expect(isSessionWorkspaceItemLoading(state)).toBe(false);
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
      sidebarContent: null,
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

    const content = await loadedSidebarContent(handleOpenSidebar);
    expect(content).toMatchObject({ kind: "file" });
    expect(content.kind === "file" ? content.edit : undefined).toBeUndefined();
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
        agentsList: [],
        sessionKey: "agent:main:current",
        sidebarContent: null,
        sessions: { getFile, listFiles },
      } as unknown as SessionWorkspaceHost;

      createSessionWorkspaceProps(state, { expanded: true });
      await vi.waitFor(() => expect(listFiles).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(createSessionWorkspaceProps(state).list).not.toBeNull());

      const container = document.createElement("div");
      render(
        renderSessionWorkspaceRail(createSessionWorkspaceProps(state, { expanded: true })),
        container,
      );
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
      sidebarContent: null,
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

    expect(await loadedSidebarContent(handleOpenSidebar)).toMatchObject({
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
      sidebarContent: null,
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
    expect(handleOpenSidebar).toHaveBeenCalledOnce();
    expect(handleOpenSidebar).toHaveBeenCalledWith(null);
  });

  it("does not render base64 content as text when the preview discriminator disagrees", async () => {
    const handleOpenSidebar = vi.fn();
    const state = {
      client: {},
      connected: true,
      handleOpenSidebar,
      hello: gatewayHello([]),
      sessionKey: "agent:main:current",
      sidebarContent: null,
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
    expect(handleOpenSidebar).toHaveBeenCalledOnce();
    expect(handleOpenSidebar).toHaveBeenCalledWith(null);
  });

  it("opens unsupported session files as metadata without treating bytes as text", async () => {
    const handleOpenSidebar = vi.fn();
    const state = {
      client: {},
      connected: true,
      handleOpenSidebar,
      hello: gatewayHello([]),
      sessionKey: "agent:main:current",
      sidebarContent: null,
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

    const sidebarContent = await loadedSidebarContent(handleOpenSidebar);
    expect(sidebarContent).toMatchObject({ kind: "markdown" });
    const content = sidebarContent.kind === "markdown" ? sidebarContent.content : "";
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
      sidebarContent: null,
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

    const sidebarContent = await loadedSidebarContent(handleOpenSidebar);
    const content = sidebarContent.kind === "markdown" ? sidebarContent.content : "";
    expect(content).toContain(
      "``  build/`\\n\\n![remote](https://example.com/x) report~~old~~&amp;.db  ``",
    );
    expect(content).not.toContain("\n\n![remote]");
    expect(content).not.toContain("Updated:");
  });
});
