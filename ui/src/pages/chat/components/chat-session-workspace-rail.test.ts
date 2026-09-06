/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSessionWorkspaceRail } from "./chat-session-workspace-rail.ts";
import type { SessionWorkspaceProps } from "./chat-session-workspace-types.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("session workspace path actions", () => {
  it("renders file-shaped placeholders while the initial workspace list loads", async () => {
    const workspace = {
      collapsed: false,
      sessionKey: "agent:main:workspace",
      list: null,
      loading: true,
      error: null,
      activeId: null,
      dock: "right" as const,
      narrowLayout: false,
      onToggleCollapsed: vi.fn(),
      onSetDock: vi.fn(),
      onRefresh: vi.fn(),
      onBrowsePath: vi.fn(),
      onOpenFile: vi.fn(),
      onSearch: vi.fn(),
      onOpenArtifact: vi.fn(),
    } satisfies SessionWorkspaceProps;
    const mount = document.body.appendChild(document.createElement("div"));

    render(renderSessionWorkspaceRail(workspace, { embedded: true }), mount);

    const skeleton = mount.querySelector("openclaw-panel-loading-skeleton");
    expect(skeleton).toBeInstanceOf(HTMLElement);
    await (skeleton as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
    expect(skeleton?.getAttribute("data-panel-skeleton")).toBe("files");
    expect(skeleton?.shadowRoot?.querySelectorAll(".skeleton").length).toBeGreaterThan(3);
    expect(mount.textContent).not.toContain("Loading session workspace");
  });

  it.each(
    [
      {
        surface: "session Files",
        selector: ".chat-workspace-rail__list:not(.chat-workspace-rail__list--browser)",
        path: "src/edited.ts",
        origin: "session" as const,
      },
      {
        surface: "project browser",
        selector: ".chat-workspace-rail__list--browser",
        path: "src/browser.ts",
        origin: "workspace" as const,
      },
    ].flatMap((surface) =>
      [false, true].map((failed) => ({
        surface: surface.surface,
        selector: surface.selector,
        path: surface.path,
        origin: surface.origin,
        failed,
        feedback: failed ? "Copy failed" : "Copied!",
      })),
    ),
  )("shows $feedback when copying a $surface path", async (testCase) => {
    const writeText = testCase.failed
      ? vi.fn().mockRejectedValue(new DOMException("Clipboard access denied", "NotAllowedError"))
      : vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onOpenFile = vi.fn();
    const workspace = {
      collapsed: false,
      sessionKey: "agent:main:workspace",
      list: {
        sessionKey: "agent:main:workspace",
        root: "/synthetic/project",
        files: [
          { kind: "modified" as const, name: "edited.ts", path: "src/edited.ts", missing: false },
        ],
        browser: {
          path: "",
          entries: [{ kind: "file" as const, name: "browser.ts", path: "src/browser.ts" }],
        },
      },
      loading: false,
      error: null,
      activeId: null,
      dock: "right" as const,
      narrowLayout: false,
      onToggleCollapsed: vi.fn(),
      onSetDock: vi.fn(),
      onRefresh: vi.fn(),
      onBrowsePath: vi.fn(),
      onOpenFile,
      onSearch: vi.fn(),
      onOpenArtifact: vi.fn(),
    } satisfies SessionWorkspaceProps;
    const mount = document.body.appendChild(document.createElement("div"));
    render(renderSessionWorkspaceRail(workspace), mount);

    const row = mount.querySelector<HTMLElement>(`${testCase.selector} .chat-workspace-rail__file`);
    expect(row).toBeInstanceOf(HTMLElement);
    const rowClick = vi.fn();
    row!.addEventListener("click", rowClick);
    const copy = row!.querySelector<HTMLButtonElement>('button[aria-label="Copy path"]');
    expect(copy).toBeInstanceOf(HTMLButtonElement);

    copy!.click();
    await vi.waitFor(() => expect(copy!.getAttribute("aria-label")).toBe(testCase.feedback));

    expect(writeText).toHaveBeenCalledWith(testCase.path);
    const feedback = copy!.parentElement?.querySelector<HTMLElement>('[role="status"]');
    expect(feedback?.textContent).toBe(testCase.feedback);
    expect(feedback?.hidden).toBe(false);
    expect(rowClick).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();

    const preview = row!.querySelector<HTMLButtonElement>('button[aria-label="Preview"]');
    expect(preview).toBeInstanceOf(HTMLButtonElement);
    preview!.click();
    expect(onOpenFile).toHaveBeenCalledWith(testCase.path, testCase.origin);
  });
});
