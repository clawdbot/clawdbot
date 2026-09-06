/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./memory-memories.ts";

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type MemoryMemoriesTestElement = HTMLElement & {
  client: GatewayBrowserClient | null;
  connected: boolean;
  methodAdvertised: boolean;
  agentId: string | null;
  updateComplete: Promise<unknown>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createElement(request: Request, advertised = true) {
  const element = document.createElement("openclaw-memory-memories") as MemoryMemoriesTestElement;
  element.client = { request } as unknown as GatewayBrowserClient;
  element.connected = true;
  element.methodAdvertised = advertised;
  element.agentId = "main";
  document.body.append(element);
  return element;
}

async function typeQuery(element: MemoryMemoriesTestElement, query: string) {
  await element.updateComplete;
  const input = element.querySelector<HTMLInputElement>("#memory-search-input");
  if (!input) {
    throw new Error("missing memory search input");
  }
  input.value = query;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await element.updateComplete;
}

function submit(element: MemoryMemoriesTestElement) {
  element
    .querySelector("form")
    ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
}

const result = {
  path: "memory/people/ada.md",
  startLine: 2,
  endLine: 3,
  score: 0.876,
  snippet: "Ada prefers careful reviews.",
  source: "memory" as const,
};

describe("MemoryMemoriesElement", () => {
  it("renders idle and gateway-update-required states", async () => {
    const current = createElement(vi.fn(() => Promise.resolve({})));
    await current.updateComplete;
    expect(current.textContent).toContain("Search for a person, project, decision");
    expect(current.querySelector("form")).not.toBeNull();
    current.remove();

    const old = createElement(
      vi.fn(() => Promise.resolve({})),
      false,
    );
    await old.updateComplete;
    expect(old.textContent).toContain("Update the gateway to search memories");
    expect(old.querySelector("form")).toBeNull();
    old.remove();
  });

  it("keeps search disabled when no agent is available", async () => {
    const request = vi.fn(() => Promise.resolve({}));
    const element = createElement(request);
    try {
      element.agentId = null;
      await typeQuery(element, "Ada");
      expect(element.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
        true,
      );
      submit(element);
      expect(request).not.toHaveBeenCalled();
    } finally {
      element.remove();
    }
  });

  it("searches only on submit and renders loading, ready, mode, and result metadata", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn(() => pending.promise);
    const element = createElement(request);
    try {
      await typeQuery(element, "Ada");
      expect(request).not.toHaveBeenCalled();

      submit(element);
      await waitForFast(() => expect(element.textContent).toContain("Searching memories"));
      expect(request).toHaveBeenCalledWith("memory.search", { query: "Ada", agentId: "main" });

      pending.resolve({
        agentId: "main",
        provider: "local",
        searchMode: "hybrid",
        results: [result],
      });
      await waitForFast(() => expect(element.textContent).toContain(result.snippet));
      expect(element.textContent).toContain("hybrid search");
      expect(element.textContent?.replace(/\s+/g, " ")).toContain(
        "memory/people/ada.md · lines 2–3",
      );
      expect(element.textContent).toContain("score 0.88");
      expect(element.textContent).toContain("memory");
    } finally {
      element.remove();
    }
  });

  it("renders empty and retryable error states", async () => {
    const request = vi
      .fn<Request>()
      .mockRejectedValueOnce(new Error("index unavailable"))
      .mockResolvedValueOnce({
        agentId: "main",
        provider: "none",
        searchMode: "fts-only",
        results: [],
      });
    const element = createElement(request);
    try {
      await typeQuery(element, "missing");
      submit(element);
      await waitForFast(() => expect(element.textContent).toContain("index unavailable"));

      const retry = [...element.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Retry",
      );
      retry?.click();
      await waitForFast(() => expect(element.textContent).toContain("No memories matched"));
      expect(element.textContent).toContain("keyword search");
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      element.remove();
    }
  });

  it("loads a row file once, highlights the matched range, and keeps one row open", async () => {
    const second = { ...result, path: "memory/projects/Open Claw.md", startLine: 1, endLine: 1 };
    const request = vi.fn((method: string) => {
      if (method === "memory.search") {
        return Promise.resolve({
          agentId: "main",
          provider: "local",
          searchMode: "hybrid",
          results: [result, second],
        });
      }
      return Promise.resolve({
        agentId: "main",
        file: {
          path: result.path,
          name: "ada.md",
          size: 30,
          updatedAtMs: 1,
          mimeType: "text/plain",
          encoding: "utf8",
          content: "first\nmatched two\nmatched three\nfourth",
        },
      });
    });
    const element = createElement(request);
    try {
      await typeQuery(element, "Ada");
      submit(element);
      await waitForFast(() => expect(element.querySelectorAll("article")).toHaveLength(2));

      const rows = element.querySelectorAll<HTMLButtonElement>("article > button");
      rows[0]?.click();
      await waitForFast(() =>
        expect(element.querySelector('[data-memory-match="true"]')).toBeTruthy(),
      );
      expect(element.querySelector('[data-memory-match="true"]')?.textContent).toBe(
        "matched two\nmatched three",
      );

      rows[0]?.click();
      rows[0]?.click();
      await element.updateComplete;
      expect(
        request.mock.calls.filter(([method]) => method === "agents.workspace.get"),
      ).toHaveLength(1);
      expect(request).toHaveBeenCalledWith("agents.workspace.get", {
        agentId: "main",
        path: result.path,
      });

      rows[1]?.click();
      await element.updateComplete;
      expect(rows[0]?.getAttribute("aria-expanded")).toBe("false");
      expect(rows[1]?.getAttribute("aria-expanded")).toBe("true");
      expect(rows[1]?.getAttribute("aria-controls")).toBe("memory-detail-1");
      expect(element.querySelector("#memory-detail-1")).not.toBeNull();
    } finally {
      element.remove();
    }
  });

  it("keeps session, absolute, and escaping paths non-expandable", async () => {
    const nonExpandable = [
      { ...result, path: "sessions/main/session-1.jsonl", source: "sessions" as const },
      { ...result, path: "sessions/main/mislabeled.jsonl" },
      { ...result, path: "/external/MEMORY.md" },
      { ...result, path: "C:\\external\\MEMORY.md" },
      { ...result, path: "memory/../outside.md" },
    ];
    const request = vi.fn<Request>(() =>
      Promise.resolve({
        agentId: "main",
        provider: "local",
        searchMode: "hybrid",
        results: [{ ...result, path: "MEMORY.md" }, ...nonExpandable],
      }),
    );
    const element = createElement(request);
    try {
      await typeQuery(element, "memory");
      submit(element);
      await waitForFast(() => expect(element.querySelectorAll("article")).toHaveLength(6));

      expect(element.querySelectorAll("article > button")).toHaveLength(1);
      expect(element.querySelectorAll("article > div.settings-row")).toHaveLength(5);
      expect(
        request.mock.calls.filter(([method]) => method === "agents.workspace.get"),
      ).toHaveLength(0);
    } finally {
      element.remove();
    }
  });

  it("keeps workspace read failures on the expanded row", async () => {
    const request = vi.fn((method: string) =>
      method === "memory.search"
        ? Promise.resolve({
            agentId: "main",
            provider: "local",
            searchMode: "hybrid",
            results: [result],
          })
        : Promise.reject(new Error("workspace file not found")),
    );
    const element = createElement(request);
    try {
      await typeQuery(element, "Ada");
      submit(element);
      await waitForFast(() => expect(element.querySelector("article > button")).not.toBeNull());
      element.querySelector<HTMLButtonElement>("article > button")?.click();

      await waitForFast(() =>
        expect(element.textContent).toContain(
          "Could not load this memory file: workspace file not found",
        ),
      );
      expect(element.textContent).toContain(result.snippet);
      expect(element.textContent).not.toContain("Memory search failed");
    } finally {
      element.remove();
    }
  });

  it("resets results when the selected agent changes", async () => {
    const request = vi.fn(() =>
      Promise.resolve({
        agentId: "main",
        provider: "local",
        searchMode: "hybrid",
        results: [result],
      }),
    );
    const element = createElement(request);
    try {
      await typeQuery(element, "Ada");
      submit(element);
      await waitForFast(() => expect(element.textContent).toContain(result.snippet));

      element.agentId = "research";
      await waitForFast(() => expect(element.textContent).toContain("Search for a person"));
      expect(element.textContent).not.toContain(result.snippet);
      expect(element.querySelector<HTMLInputElement>("#memory-search-input")?.value).toBe("");
    } finally {
      element.remove();
    }
  });
});
