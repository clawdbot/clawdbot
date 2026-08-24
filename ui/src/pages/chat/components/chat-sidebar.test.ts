/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { openEditor } from "../../../lib/editor-links.ts";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../../../test-helpers/native-gateways.ts";
import { hasUniformLineEndings } from "./chat-sidebar.ts";

describe("hasUniformLineEndings", () => {
  it("accepts uniform and no line endings", () => {
    expect(hasUniformLineEndings("no endings")).toBe(true);
    expect(hasUniformLineEndings("a\nb\nc\n")).toBe(true);
    expect(hasUniformLineEndings("a\r\nb\r\nc\r\n")).toBe(true);
    expect(hasUniformLineEndings("a\rb\rc")).toBe(true);
  });

  it("rejects mixed line endings regardless of order", () => {
    expect(hasUniformLineEndings("a\r\nb\nc")).toBe(false);
    expect(hasUniformLineEndings("a\nb\r\nc")).toBe(false);
    expect(hasUniformLineEndings("a\rb\nc")).toBe(false);
  });
});

describe("openEditor", () => {
  it.each([
    [
      "plain path",
      "cursor",
      "/workspace/src/foo.ts",
      undefined,
      "cursor://file/workspace/src/foo.ts",
    ],
    [
      "spaces",
      "vscode",
      "/workspace/My File.ts",
      undefined,
      "vscode://file/workspace/My%20File.ts",
    ],
    ["target line", "zed", "/workspace/src/foo.ts", 42, "zed://file/workspace/src/foo.ts:42"],
    [
      "Windows path",
      "vscode",
      "C:\\workspace\\src\\foo.ts",
      42,
      "vscode://file/C:/workspace/src/foo.ts:42",
    ],
    [
      "URL-significant characters",
      "windsurf",
      "/workspace/#notes?.md",
      undefined,
      "windsurf://file/workspace/%23notes%3F.md",
    ],
  ] as const)("opens the encoded custom URL for %s", (_name, editor, path, line, expected) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openEditor(editor, path, line);
    expect(open).toHaveBeenCalledWith(expected);
    open.mockRestore();
  });
});

describe("file sidebar editor locality", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    clearNativeGatewayTestState();
  });

  it.each([
    { name: "plain browser", nativeGateway: null, offered: false },
    { name: "native local gateway", nativeGateway: "local", offered: true },
    // Covers the documented `ssh -N -L 18789:127.0.0.1:18789` tunnel: the URL
    // is loopback, the workspace is not. Only the native kind catches this.
    { name: "native remote gateway", nativeGateway: "remote", offered: false },
    {
      name: "remote execution node",
      nativeGateway: "local",
      execNode: "build-mac",
      offered: false,
    },
  ] as const)("offers editors only for native-local files: $name", async (testCase) => {
    setNativeGatewayTestState(testCase.nativeGateway);
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      execNode: string | null;
      ensureFileEditor: () => Promise<void>;
      updateComplete: Promise<unknown>;
    };
    panel.execNode = "execNode" in testCase ? (testCase.execNode ?? null) : null;
    panel.content = {
      kind: "file",
      path: "src/example.ts",
      name: "example.ts",
      root: "/workspace",
      content: "const answer = 42;",
    };
    vi.spyOn(panel, "ensureFileEditor").mockResolvedValue();
    document.body.append(panel);
    await panel.updateComplete;

    expect(panel.querySelector('[aria-label="Open in editor"]') !== null).toBe(testCase.offered);
    expect(panel.querySelectorAll(".sidebar-file-view__editor-item")).toHaveLength(
      testCase.offered ? 4 : 0,
    );
    // Absent, not merely disabled: a dead control cannot explain why it is dead.
    expect(panel.querySelector(".sidebar-file-view__editor") !== null).toBe(testCase.offered);
  });

  it("removes editor controls when the native gateway switches to remote", async () => {
    setNativeGatewayTestState("local");
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      ensureFileEditor: () => Promise<void>;
      updateComplete: Promise<unknown>;
    };
    panel.content = {
      kind: "file",
      path: "src/example.ts",
      name: "example.ts",
      root: "/workspace",
      content: "const answer = 42;",
    };
    vi.spyOn(panel, "ensureFileEditor").mockResolvedValue();
    document.body.append(panel);
    await panel.updateComplete;
    expect(panel.querySelector('[aria-label="Open in editor"]')).not.toBeNull();

    setNativeGatewayTestState("remote");
    await panel.updateComplete;

    expect(panel.querySelector('[aria-label="Open in editor"]')).toBeNull();
    expect(panel.querySelector(".sidebar-file-view__editor")).toBeNull();
  });
});

describe("markdown sidebar", () => {
  it("opens workspace files from markdown preview clicks", async () => {
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
      updateComplete?: Promise<unknown>;
    };
    const onOpenWorkspaceFile = vi.fn();
    panel.content = {
      kind: "markdown",
      content: "See `ui/src/pages/chat/chat-view.ts:362`",
    };
    panel.onOpenWorkspaceFile = onOpenWorkspaceFile;
    document.body.append(panel);
    await panel.updateComplete;

    panel.querySelector<HTMLAnchorElement>("a.markdown-file-link")?.click();

    expect(onOpenWorkspaceFile).toHaveBeenCalledWith({
      path: "ui/src/pages/chat/chat-view.ts",
      line: 362,
    });
    panel.remove();
  });

  it.each([
    ["a Hebrew document as rtl", "מסמך בעברית עם כמה שורות טקסט", "rtl"],
    ["a Hebrew heading behind Markdown punctuation as rtl", "## כותרת ראשית", "rtl"],
    ["an English document as ltr", "# Heading\n\nPlain English body.", "ltr"],
    // The raw-text view hands the same panel one fenced block; direction still
    // comes from the first strong character, not from the fence.
    ["raw Hebrew text as rtl", "```\nשורה ראשונה\n```", "rtl"],
  ] as const)("renders %s", async (_name, markdown, expected) => {
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      updateComplete?: Promise<unknown>;
    };
    panel.content = { kind: "markdown", content: markdown };
    document.body.append(panel);
    await panel.updateComplete;

    expect(panel.querySelector(".sidebar-markdown-reader")?.getAttribute("dir")).toBe(expected);
    panel.remove();
  });

  it.each(["Enter", " "])("opens focused markdown preview file links with %j", async (key) => {
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
      updateComplete?: Promise<unknown>;
    };
    const onOpenWorkspaceFile = vi.fn();
    panel.content = { kind: "markdown", content: "See `ui/src/pages/chat/chat-view.ts:362`" };
    panel.onOpenWorkspaceFile = onOpenWorkspaceFile;
    document.body.append(panel);
    await panel.updateComplete;

    const link = panel.querySelector<HTMLAnchorElement>("a.markdown-file-link");
    link?.focus();
    expect(document.activeElement).toBe(link);
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    link?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onOpenWorkspaceFile).toHaveBeenCalledOnce();
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith({
      path: "ui/src/pages/chat/chat-view.ts",
      line: 362,
    });
    panel.remove();
  });

  it.each(["click", "Ctrl+click", "Enter", " "])(
    "handles markdown preview session links with %j",
    async (action) => {
      const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
        content: unknown;
        onOpenSessionLink?: (target: { sessionKey: string; agentId: string }) => void;
        updateComplete?: Promise<unknown>;
      };
      const onOpenSessionLink = vi.fn();
      const sessionKey = "agent:roboclaw:dashboard:2139bddb-3211-4641-b993-10f619f124e6";
      panel.content = { kind: "markdown", content: `Open \`${sessionKey}\`` };
      panel.onOpenSessionLink = onOpenSessionLink;
      document.body.append(panel);
      await panel.updateComplete;

      const link = panel.querySelector<HTMLAnchorElement>("a.markdown-session-link");
      if (action === "click" || action === "Ctrl+click") {
        link?.setAttribute("href", "/chat/roboclaw/2139bddb");
        const modified = action === "Ctrl+click";
        const event = new MouseEvent("click", {
          bubbles: true,
          button: 0,
          cancelable: true,
          ctrlKey: modified,
        });
        link?.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(!modified);
        if (modified) {
          expect(onOpenSessionLink).not.toHaveBeenCalled();
          panel.remove();
          return;
        }
      } else {
        link?.focus();
        const event = new KeyboardEvent("keydown", {
          key: action,
          bubbles: true,
          cancelable: true,
        });
        link?.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }

      expect(onOpenSessionLink).toHaveBeenCalledWith({ sessionKey, agentId: "roboclaw" });
      panel.remove();
    },
  );

  it.each(["click", "Enter"])(
    "SPA-routes markdown preview session hrefs with %s",
    async (action) => {
      const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
        basePath?: string;
        content: unknown;
        onOpenSessionLink?: (target: unknown) => void;
        updateComplete?: Promise<unknown>;
      };
      const onOpenSessionLink = vi.fn();
      const literalUuid = "12345678-90ab-cdef-1234-567890abcdef";
      const href = `${window.location.origin}/control/dashboard/main/~key/${literalUuid}`;
      panel.basePath = "/control";
      panel.content = { kind: "markdown", content: `[Open session](${href})` };
      panel.onOpenSessionLink = onOpenSessionLink;
      document.body.append(panel);
      await panel.updateComplete;

      const link = panel.querySelector<HTMLAnchorElement>(`a[href^="${window.location.origin}"]`);
      const event =
        action === "click"
          ? new MouseEvent("click", { bubbles: true, button: 0, cancelable: true })
          : new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      link?.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(onOpenSessionLink).toHaveBeenCalledWith({
        namespace: "dashboard",
        pathname: `/control/dashboard/main/~key/${literalUuid}`,
      });
      panel.remove();
    },
  );

  it("activates Markdown images only when a chat owner opts in", async () => {
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      onOpenImage?: (item: { src: string; title: string }) => void;
      updateComplete?: Promise<unknown>;
    };
    const onOpenImage = vi.fn();
    panel.content = { kind: "markdown", content: "![Preview](data:image/png;base64,cG5n)" };
    panel.onOpenImage = onOpenImage;
    document.body.append(panel);
    await panel.updateComplete;

    panel.querySelector<HTMLButtonElement>(".markdown-inline-image-button")?.click();
    expect(onOpenImage).toHaveBeenCalledWith({
      src: "data:image/png;base64,cG5n",
      title: "Preview",
    });
    panel.remove();

    const fallbackPanel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      updateComplete?: Promise<unknown>;
    };
    fallbackPanel.content = {
      kind: "markdown",
      content: "![Preview](data:image/png;base64,cG5n)",
    };
    document.body.append(fallbackPanel);
    await fallbackPanel.updateComplete;
    expect(fallbackPanel.querySelector(".markdown-inline-image-button")).toBeNull();
    fallbackPanel.remove();
  });

  it("opens image artifacts through the shared lightbox callback", async () => {
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      onOpenImage?: (item: { src: string; title: string }) => void;
      updateComplete?: Promise<unknown>;
    };
    const onOpenImage = vi.fn();
    panel.content = {
      kind: "image",
      title: "Artifact preview",
      src: "data:image/png;base64,cG5n",
    };
    panel.onOpenImage = onOpenImage;
    document.body.append(panel);
    await panel.updateComplete;

    panel.querySelector<HTMLButtonElement>(".chat-tool-card__preview-image-button")?.click();

    expect(onOpenImage).toHaveBeenCalledWith({
      src: "data:image/png;base64,cG5n",
      title: "Artifact preview",
    });
    panel.remove();

    const fallbackPanel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      updateComplete?: Promise<unknown>;
    };
    fallbackPanel.content = {
      kind: "image",
      title: "Artifact preview",
      src: "data:image/png;base64,cG5n",
    };
    document.body.append(fallbackPanel);
    await fallbackPanel.updateComplete;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    fallbackPanel
      .querySelector<HTMLButtonElement>(".chat-tool-card__preview-image-button")
      ?.click();
    expect(openSpy).toHaveBeenCalledWith(
      "data:image/png;base64,cG5n",
      "_blank",
      "noopener,noreferrer",
    );
    openSpy.mockRestore();
    fallbackPanel.remove();
  });

  it("preserves authenticated transcoded video playback in attachment previews", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      updateComplete?: Promise<unknown>;
    };
    panel.content = {
      kind: "attachment",
      title: "clip.mov",
      src: "/api/chat/media/outgoing/session/artifact/full?mediaTicket=ticket",
      sourceIdentity: "artifact:clip",
      mimeType: "video/quicktime",
      playback: "transcode",
      authToken: "session-token",
    };
    document.body.append(panel);
    await panel.updateComplete;

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("playback=1");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer session-token");
    expect(panel.querySelector("openclaw-chat-video-player")).not.toBeNull();
    expect(panel.querySelector(":scope > video")).toBeNull();
    panel.remove();
  });

  it("keeps a canvas scripts ceiling under a trusted global sandbox", async () => {
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      embedSandboxMode: "trusted";
      canvasPluginSurfaceUrl: string;
      updateComplete?: Promise<unknown>;
    };
    panel.embedSandboxMode = "trusted";
    panel.canvasPluginSurfaceUrl = "https://canvas.example";
    panel.content = {
      kind: "canvas",
      docId: "preview-1",
      title: "Preview",
      entryUrl: "https://canvas.example/previews/preview-1",
      sandbox: "scripts",
    };
    document.body.append(panel);
    await panel.updateComplete;

    expect(panel.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(panel.querySelector("iframe")?.getAttribute("sandbox")).not.toContain(
      "allow-same-origin",
    );
    panel.remove();
  });
});

describe("file sidebar clipboard feedback", () => {
  const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
  const copyActions = [
    { label: "Copy path", value: "src/example.ts" },
    { label: "Copy file contents", value: "const answer = 42;" },
  ];

  type FilePanel = HTMLElement & {
    content: unknown;
    ensureFileEditor: () => Promise<void>;
    updateComplete: Promise<unknown>;
  };

  async function mountFilePanel(): Promise<FilePanel> {
    const panel = document.createElement("openclaw-chat-detail-panel") as FilePanel;
    panel.content = {
      kind: "file",
      path: "src/example.ts",
      name: "example.ts",
      content: "const answer = 42;",
    };
    vi.spyOn(panel, "ensureFileEditor").mockResolvedValue();
    document.body.append(panel);
    await panel.updateComplete;
    return panel;
  }

  function findCopyButton(panel: FilePanel, label: string): HTMLButtonElement {
    const button = Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.getAttribute("aria-label") === label,
    );
    if (!button) {
      throw new Error(`Missing sidebar button: ${label}`);
    }
    return button;
  }

  function denyClipboard() {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Clipboard access denied"));
    const execCommand = vi.fn(() => false);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    return { execCommand, writeText };
  }

  function captureFeedbackTimers() {
    const schedule = vi.spyOn(globalThis, "setTimeout");
    return {
      schedule,
      run(delay: number, index = 0) {
        const timerIndex = schedule.mock.calls
          .map(([, timeout], callIndex) => (timeout === delay ? callIndex : -1))
          .filter((callIndex) => callIndex >= 0)[index];
        if (timerIndex === undefined) {
          throw new Error(`Missing sidebar clipboard reset timer after ${delay}ms`);
        }
        const reset = schedule.mock.calls[timerIndex]?.[0];
        if (typeof reset !== "function") {
          throw new Error(`Expected sidebar clipboard reset timer after ${delay}ms`);
        }
        globalThis.clearTimeout(schedule.mock.results[timerIndex]?.value);
        reset();
      },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalExecCommand) {
      Object.defineProperty(document, "execCommand", originalExecCommand);
    } else {
      Reflect.deleteProperty(document, "execCommand");
    }
    document.body.replaceChildren();
  });

  it.each(copyActions)(
    "shows and resets a visible accessible error when $label fails",
    async ({ label, value }) => {
      const { execCommand, writeText } = denyClipboard();
      const panel = await mountFilePanel();
      const button = findCopyButton(panel, label);
      const timers = captureFeedbackTimers();

      button.click();
      await vi.waitFor(() => expect(button.getAttribute("aria-label")).toBe("Copy failed"));

      expect(writeText).toHaveBeenCalledWith(value);
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(panel.querySelector('[role="alert"]')?.textContent).toContain("Copy failed");

      timers.run(2_000);
      await panel.updateComplete;

      expect(button.getAttribute("aria-label")).toBe(label);
      expect(panel.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it.each(copyActions)(
    "preserves and resets successful $label feedback",
    async ({ label, value }) => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const panel = await mountFilePanel();
      const button = findCopyButton(panel, label);
      const timers = captureFeedbackTimers();

      button.click();
      await vi.waitFor(() => expect(button.getAttribute("aria-label")).toBe("Copied!"));

      expect(writeText).toHaveBeenCalledWith(value);
      expect(button.classList.contains("copied")).toBe(true);
      expect(panel.querySelector('[role="alert"]')).toBeNull();

      timers.run(1_500);
      await panel.updateComplete;

      expect(button.getAttribute("aria-label")).toBe(label);
      expect(button.classList.contains("copied")).toBe(false);
    },
  );

  it.each(copyActions)(
    "ignores an older successful $label attempt after a failed retry",
    async ({ label }) => {
      const { writeText } = denyClipboard();
      let finishFirstCopy = () => {};
      writeText.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishFirstCopy = resolve;
        }),
      );
      const panel = await mountFilePanel();
      const button = findCopyButton(panel, label);

      button.click();
      button.click();
      await vi.waitFor(() => expect(button.getAttribute("aria-label")).toBe("Copy failed"));
      finishFirstCopy();
      await Promise.resolve();
      await Promise.resolve();
      await panel.updateComplete;

      expect(writeText).toHaveBeenCalledTimes(2);
      expect(button.getAttribute("aria-label")).toBe("Copy failed");
      expect(panel.querySelector('[role="alert"]')?.textContent).toContain("Copy failed");
    },
  );

  it("keeps path and contents feedback reset timers independent", async () => {
    denyClipboard();
    const panel = await mountFilePanel();
    const pathButton = findCopyButton(panel, "Copy path");
    const contentsButton = findCopyButton(panel, "Copy file contents");
    const timers = captureFeedbackTimers();

    pathButton.click();
    contentsButton.click();
    await vi.waitFor(() => {
      expect(pathButton.getAttribute("aria-label")).toBe("Copy failed");
      expect(contentsButton.getAttribute("aria-label")).toBe("Copy failed");
    });

    timers.run(2_000);
    await panel.updateComplete;
    expect(pathButton.getAttribute("aria-label")).toBe("Copy path");
    expect(contentsButton.getAttribute("aria-label")).toBe("Copy failed");
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain("Copy failed");

    timers.run(2_000, 1);
    await panel.updateComplete;
    expect(contentsButton.getAttribute("aria-label")).toBe("Copy file contents");
    expect(panel.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(["file selection", "disconnection"])(
    "ignores a delayed successful copy after %s changes its owner",
    async (change) => {
      let finishCopy = () => {};
      const writeText = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishCopy = resolve;
          }),
      );
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const panel = await mountFilePanel();
      const button = findCopyButton(panel, "Copy file contents");
      const timers = captureFeedbackTimers();

      button.click();
      if (change === "file selection") {
        panel.content = {
          kind: "file",
          path: "src/next.ts",
          name: "next.ts",
          content: "const next = true;",
        };
        await panel.updateComplete;
      } else {
        panel.remove();
      }
      finishCopy();
      await Promise.resolve();
      await Promise.resolve();
      await panel.updateComplete;

      expect(timers.schedule.mock.calls.some(([, delay]) => delay === 1_500)).toBe(false);
      expect(button.getAttribute("aria-label")).toBe("Copy file contents");
      expect(panel.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it.each([
    { label: "Copy path", failed: true },
    { label: "Copy file contents", failed: false },
  ])(
    "restores idle $label feedback when the same sidebar reconnects",
    async ({ label, failed }) => {
      if (failed) {
        denyClipboard();
      } else {
        vi.stubGlobal("navigator", {
          clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
        });
      }
      const panel = await mountFilePanel();
      const button = findCopyButton(panel, label);

      button.click();
      await vi.waitFor(() =>
        expect(button.getAttribute("aria-label")).toBe(failed ? "Copy failed" : "Copied!"),
      );

      panel.remove();
      document.body.append(panel);
      await panel.updateComplete;

      expect(findCopyButton(panel, label)).toBe(button);
      expect(button.classList.contains("copied")).toBe(false);
      expect(panel.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it.each(copyActions)(
    "ignores an older $label completion after sidebar reconnection",
    async ({ label }) => {
      let finishCopy = () => {};
      const writeText = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishCopy = resolve;
          }),
      );
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const panel = await mountFilePanel();
      const button = findCopyButton(panel, label);
      const timers = captureFeedbackTimers();

      button.click();
      panel.remove();
      document.body.append(panel);
      await panel.updateComplete;
      finishCopy();
      await Promise.resolve();
      await Promise.resolve();
      await panel.updateComplete;

      expect(button.getAttribute("aria-label")).toBe(label);
      expect(timers.schedule.mock.calls.some(([, delay]) => delay === 1_500)).toBe(false);
      expect(panel.querySelector('[role="alert"]')).toBeNull();
    },
  );
});
