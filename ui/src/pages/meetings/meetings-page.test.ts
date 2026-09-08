import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { meetingEntry, meetingPage } from "../../test-helpers/transcripts.test-support.ts";
import { transcriptListParams } from "./route-state.ts";
import "./meetings-page.ts";

type TestPage = HTMLElement & {
  context: ApplicationContext;
  routeSearch: string;
  updateComplete: Promise<boolean>;
};

function mount(request: ReturnType<typeof vi.fn>, search = "", scopes = ["operator.admin"]) {
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  const snapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello: { auth: { role: "operator", scopes } },
  } as ApplicationGatewaySnapshot;
  const page = document.createElement("openclaw-meetings-page") as TestPage;
  const navigate = vi.fn((_route: string, options: { search: string }) => {
    page.routeSearch = options.search;
  });
  page.context = {
    basePath: "",
    navigate,
    gateway: {
      snapshot,
      subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as ApplicationContext;
  page.routeSearch = search;
  document.body.append(page);
  return {
    page,
    snapshot,
    notify: () => listeners.forEach((listener) => listener(snapshot)),
    navigate,
  };
}

function button(page: Element, text: string) {
  const result = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === text,
  );
  if (!result) {
    throw new Error(`Missing button: ${text}`);
  }
  return result;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("meeting transcript library", () => {
  it("keeps large saved notes readable and exportable when a transcript page exceeds its budget", async () => {
    const markdown = `# Design review\n\nPreviously saved large notes.\n\n${"x".repeat(1024 * 1024)}`;
    const request = vi.fn(async (method: string, params: { limit?: number }) => {
      if (method === "transcripts.list") {
        return { sessions: [], nextCursor: null };
      }
      if (method === "transcripts.export") {
        return {
          data: btoa("Complete saved notes"),
          filename: "notes.md",
          mimeType: "text/markdown",
        };
      }
      if (params.limit !== undefined) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Transcript page exceeds its byte limit",
          details: { type: "transcript_result_too_large" },
        });
      }
      return {
        ...meetingPage,
        utterances: undefined,
        summary: { ...meetingPage.summary, markdown },
      };
    });
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = vi.fn(() => "blob:notes");
        static override revokeObjectURL = vi.fn();
      },
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { page } = mount(request, "?selector=meeting");
    await vi.waitFor(() =>
      expect(page.querySelector(".transcripts-summary")?.textContent ?? "").toContain(
        "Previously saved large notes.",
      ),
    );
    expect(page.textContent).not.toContain("Transcript page exceeds its byte limit");
    page
      .querySelector<HTMLElement>("#transcript-reader-tab-text")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() =>
      expect(page.querySelector(".transcripts-reader [role=alert]")?.textContent).toContain(
        "Transcript page exceeds its byte limit",
      ),
    );
    button(page, "Download Markdown").click();
    await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(page.textContent).toContain("Download started");
    page
      .querySelector<HTMLElement>("#transcript-reader-tab-summary")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() =>
      expect(page.querySelector(".transcripts-summary")?.textContent ?? "").toContain(
        "Previously saved large notes.",
      ),
    );
    expect(page.textContent).not.toContain("Transcript page exceeds its byte limit");
  });

  it("preserves every filter draft across pending responses, and clears even uncommitted filters", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn(() => pending.promise);
    const { page } = mount(request);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const filters = page.querySelector<HTMLDetailsElement>(".transcripts-filters details")!;
    expect(filters).not.toBeNull();
    expect(filters.open).toBe(false);
    filters.open = true;
    const drafts = {
      query: "unsaved title",
      providerId: "caption",
      accountId: "work",
      agentId: "notes",
      startedAfter: "2026-08-01",
      startedBefore: "2026-09-01",
    };
    for (const [key, value] of Object.entries(drafts)) {
      const input = page.querySelector<HTMLInputElement>(`input[name="${key}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event("input"));
    }
    pending.resolve({ sessions: [meetingEntry], nextCursor: null });
    await vi.waitFor(() => expect(page.textContent).toContain("Design review"));
    expect(filters.open).toBe(true);
    for (const [key, value] of Object.entries(drafts)) {
      expect(page.querySelector<HTMLInputElement>(`input[name="${key}"]`)!.value).toBe(value);
    }
    button(page, "Clear filters").click();
    await page.updateComplete;
    expect(
      [...page.querySelectorAll<HTMLInputElement>(".transcripts-filters input")].every(
        (input) => input.value === "",
      ),
    ).toBe(true);
    page.routeSearch = "?query=from-history&accountId=other";
    await page.updateComplete;
    expect(page.querySelector<HTMLInputElement>('input[name="query"]')!.value).toBe("from-history");
    expect(page.querySelector<HTMLInputElement>('input[name="accountId"]')!.value).toBe("other");
    expect(filters.open).toBe(true);
    button(page, "Clear filters").click();
    await page.updateComplete;
    expect(filters.open).toBe(false);
  });

  it("preserves reader search through pagination, tabs, and export updates, then submits and clears it", async () => {
    const more = deferred<unknown>();
    const download = deferred<unknown>();
    const request = vi.fn((method: string, params: { cursor?: string }) => {
      if (method === "transcripts.export") {
        return download.promise;
      }
      if (params.cursor) {
        return more.promise;
      }
      return Promise.resolve(
        method === "transcripts.list"
          ? { sessions: [], nextCursor: null }
          : { ...meetingPage, nextCursor: "more" },
      );
    });
    const { page } = mount(request, "?tab=transcript&selector=meeting");
    await vi.waitFor(() => expect(page.textContent).toContain("Keep the reader quiet"));
    const input = page.querySelector<HTMLInputElement>('input[name="find"]')!;
    input.value = "draft search";
    input.dispatchEvent(new Event("input"));
    button(page, "Load more").click();
    await page.updateComplete;
    expect(page.querySelector<HTMLInputElement>('input[name="find"]')!.value).toBe("draft search");
    more.resolve({ ...meetingPage, nextCursor: null });
    await vi.waitFor(() => expect(button(page, "Download Markdown").disabled).toBe(false));
    page
      .querySelector<HTMLElement>("#transcript-reader-tab-summary")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await page.updateComplete;
    expect(page.querySelector(".transcripts-summary")).not.toBeNull();
    page
      .querySelector<HTMLElement>("#transcript-reader-tab-text")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await page.updateComplete;
    button(page, "Download Markdown").click();
    await vi.waitFor(() => expect(page.textContent).toContain("Preparing download"));
    expect(page.querySelector<HTMLInputElement>('input[name="find"]')!.value).toBe("draft search");
    download.reject(new Error("Export unavailable"));
    await vi.waitFor(() => expect(page.textContent).toContain("Download failed"));
    page
      .querySelector(".transcripts-search")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "transcripts.get",
        expect.objectContaining({ query: "draft search" }),
        expect.anything(),
      ),
    );
    button(page, "Clear search").click();
    await vi.waitFor(() =>
      expect(page.querySelector<HTMLInputElement>('input[name="find"]')?.value).toBe(""),
    );
    page.routeSearch = "?tab=transcript&selector=other&find=history";
    await vi.waitFor(() =>
      expect(page.querySelector<HTMLInputElement>('input[name="find"]')?.value).toBe("history"),
    );
  });

  it("sends bounded filters, resets paging, and opens the selected meeting summary before its transcript", async () => {
    const request = vi.fn(async (method: string) =>
      method === "transcripts.list"
        ? { sessions: [meetingEntry], nextCursor: "next-page" }
        : meetingPage,
    );
    const { page } = mount(request);
    await vi.waitFor(() => expect(page.textContent).toContain("Design review"));
    const input = page.querySelector<HTMLInputElement>('input[name="query"]')!;
    expect(page.querySelector('a[href*="settings/communications"]')?.getAttribute("href")).toBe(
      "/settings/communications?section=transcripts#settings-communications-meeting-capture",
    );
    input.value = "design";
    page
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "transcripts.list",
        expect.objectContaining({ query: "design", limit: 50 }),
        expect.anything(),
      ),
    );
    button(page, "Next page").click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "transcripts.list",
        expect.objectContaining({ cursor: "next-page", query: "design" }),
        expect.anything(),
      ),
    );
    button(page, "Clear filters").click();
    await vi.waitFor(() => expect(new URLSearchParams(page.routeSearch).has("cursor")).toBe(false));
    await vi.waitFor(() => expect(page.querySelector(".transcripts-list__entry")).not.toBeNull());
    (page.querySelector(".transcripts-list__entry") as HTMLElement).click();
    await vi.waitFor(() => expect(page.textContent).toContain("Reader layout discussed."));
    expect(page.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      "Summary",
    );
    page
      .querySelector<HTMLElement>("#transcript-reader-tab-text")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() =>
      expect(page.textContent).toContain("Keep the reader quiet and readable."),
    );
    expect(request).toHaveBeenCalledWith(
      "transcripts.get",
      expect.objectContaining({ selector: meetingEntry.selector, limit: 50 }),
      expect.anything(),
    );
    expect(page.textContent).toContain("No active capture subscription");
    expect(page.textContent).toContain("Last source utterance:");
    const sourceTime = page.querySelector(".transcripts-utterances time")!;
    expect(sourceTime.getAttribute("datetime")).toBe(meetingEntry.startedAt);
    expect(sourceTime.getAttribute("aria-label")).toContain("Source time:");
    expect(sourceTime.getAttribute("title")).toBe(sourceTime.getAttribute("aria-label"));
    expect(sourceTime.textContent).not.toContain("2026");
    expect(page.textContent).not.toContain("Last saved time");
  });

  it("ignores older list responses after a new filter completes", async () => {
    const old = deferred<unknown>();
    const request = vi.fn((_method: string, params: { query?: string }) =>
      params.query === "new"
        ? Promise.resolve({
            sessions: [{ ...meetingEntry, title: "New result" }],
            nextCursor: null,
          })
        : old.promise,
    );
    const { page } = mount(request);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    page.routeSearch = "?query=new";
    await vi.waitFor(() => expect(page.textContent).toContain("New result"));
    old.resolve({ sessions: [{ ...meetingEntry, title: "Old result" }], nextCursor: null });
    await old.promise;
    await page.updateComplete;
    expect(page.textContent).not.toContain("Old result");
  });

  it("ignores stale reader pages after selection changes, then appends matching search pages", async () => {
    const old = deferred<unknown>();
    const request = vi.fn(
      (method: string, params: { selector?: string; query?: string; cursor?: string }) => {
        if (method === "transcripts.list") {
          return Promise.resolve({ sessions: [], nextCursor: null });
        }
        if (params.selector === "old") {
          return old.promise;
        }
        return Promise.resolve({
          ...meetingPage,
          session: { ...meetingEntry, selector: "new" },
          utterances: [
            {
              sequence: params.cursor ? 1 : 0,
              text: params.cursor ? "Second match" : "First match",
            },
          ],
          nextCursor: params.cursor ? null : "more",
        });
      },
    );
    const { page } = mount(request, "?tab=transcript&selector=old");
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "transcripts.get",
        expect.objectContaining({ selector: "old" }),
        expect.anything(),
      ),
    );
    page.routeSearch = "?tab=transcript&selector=new&find=match";
    await vi.waitFor(() => expect(page.textContent).toContain("First match"));
    button(page, "Load more").click();
    await vi.waitFor(() => expect(page.textContent).toContain("Second match"));
    expect(page.textContent).toContain("First match");
    old.resolve({ ...meetingPage, utterances: [{ sequence: 0, text: "Stale private text" }] });
    await old.promise;
    await page.updateComplete;
    expect(page.textContent).not.toContain("Stale private text");
    expect(request).toHaveBeenCalledWith(
      "transcripts.get",
      expect.objectContaining({ query: "match", cursor: "more", selector: "new" }),
      expect.anything(),
    );
  });

  it("clears private reader content on disconnect and does not restore a late response", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn((method: string) =>
      method === "transcripts.list"
        ? Promise.resolve({ sessions: [], nextCursor: null })
        : pending.promise,
    );
    const { page, snapshot, notify } = mount(request, "?tab=transcript&selector=meeting");
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("transcripts.get", expect.anything(), expect.anything()),
    );
    snapshot.phase = "reconnecting";
    notify();
    pending.resolve(meetingPage);
    await vi.waitFor(() => expect(page.textContent).toContain("Connect to the Gateway"));
    expect(page.textContent).not.toContain("Keep the reader quiet");
  });

  it.each([
    ["empty", null, "Your meeting notes, together"],
    ["failure", new Error("Archive unavailable"), "Could not load transcripts"],
    [
      "unavailable",
      new GatewayRequestError({ code: "UNAVAILABLE", message: "Archive unavailable" }),
      "Could not load transcripts",
    ],
    [
      "restricted",
      new GatewayRequestError({ code: "FORBIDDEN", message: "Shared archive is restricted" }),
      "Transcript access is restricted",
    ],
    [
      "missing read scope",
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Missing permission",
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.read",
          requiredScopes: ["operator.read"],
        },
      }),
      "Transcript access is restricted",
    ],
  ])("shows an honest %s state", async (_label, error, expected) => {
    const request = vi.fn(async () => {
      if (error) {
        throw error;
      }
      return { sessions: [], nextCursor: null };
    });
    const { page } = mount(request);
    await vi.waitFor(() => expect(page.textContent).toContain(expected));
  });

  it("does not request archive content without read permission", async () => {
    const request = vi.fn();
    const { page } = mount(request, "?tab=transcript&selector=private", ["operator.approvals"]);
    await page.updateComplete;
    expect(page.textContent).toContain("Transcript access is restricted");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a denied paginated archive hidden until a fresh first-page retry succeeds", async () => {
    const reads: ReturnType<typeof deferred<unknown>>[] = [];
    const summary = deferred<unknown>();
    const request = vi.fn((method: string, params: { includeUtterances?: boolean }) => {
      if (method === "transcripts.list") {
        return Promise.resolve({ sessions: [meetingEntry], nextCursor: null });
      }
      if (!params.includeUtterances) {
        return summary.promise;
      }
      const read = deferred<unknown>();
      reads.push(read);
      return read.promise;
    });
    const { page } = mount(request, "?tab=transcript&selector=meeting");
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    reads[0]!.resolve({ ...meetingPage, nextCursor: "more" });
    await vi.waitFor(() => expect(page.textContent).toContain("Keep the reader quiet"));
    button(page, "Load more").click();
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1]!.reject(new GatewayRequestError({ code: "FORBIDDEN", message: "Restricted" }));
    await vi.waitFor(() => expect(page.textContent).toContain("Transcript access is restricted"));
    const expectHidden = () => {
      const reader = page.querySelector(".transcripts-reader")!;
      expect(reader.textContent).not.toContain(meetingEntry.title);
      expect(reader.textContent).not.toContain("Keep the reader quiet");
      expect(page.querySelector(".transcripts-reader__header")).toBeNull();
      expect(page.querySelector(".transcripts-summary")).toBeNull();
    };
    expectHidden();
    await page.updateComplete;
    expect(reads).toHaveLength(2);
    for (const error of [
      new GatewayRequestError({ code: "FORBIDDEN", message: "Still restricted" }),
      new Error("Temporary network failure"),
    ]) {
      const count = reads.length;
      button(page.querySelector(".transcripts-reader")!, "Retry").click();
      await vi.waitFor(() => expect(reads).toHaveLength(count + 1));
      await page.updateComplete;
      expectHidden();
      expect(page.textContent).not.toContain(meetingEntry.title);
      expect(request).toHaveBeenLastCalledWith(
        "transcripts.get",
        expect.objectContaining({ selector: "meeting", cursor: undefined }),
        expect.anything(),
      );
      reads.at(-1)!.reject(error);
      await vi.waitFor(() =>
        expect(page.querySelector(".transcripts-reader")?.getAttribute("aria-busy")).toBe("false"),
      );
      expect(page.textContent).toContain("Transcript access is restricted");
      await page.updateComplete;
      expectHidden();
    }
    button(page.querySelector(".transcripts-reader")!, "Retry").click();
    await page.updateComplete;
    reads.at(-1)!.resolve({ ...meetingPage, nextCursor: "fresh-more" });
    await vi.waitFor(() => expect(page.textContent).toContain("Keep the reader quiet"));
    expect(page.querySelectorAll(".transcripts-utterances li")).toHaveLength(1);
    button(page, "Load more").click();
    await page.updateComplete;
    expect(request).toHaveBeenLastCalledWith(
      "transcripts.get",
      expect.objectContaining({ cursor: "fresh-more" }),
      expect.anything(),
    );
    reads.at(-1)!.resolve({
      ...meetingPage,
      utterances: [{ sequence: 1, text: "Fresh second page" }],
      nextCursor: null,
    });
    await vi.waitFor(() => expect(page.textContent).toContain("Fresh second page"));
    expect(page.querySelectorAll(".transcripts-utterances li")).toHaveLength(2);
  });

  it.each(["list", "export"])(
    "revokes cached reader data on an applicable %s denial and fences older sibling successes",
    async (deniedMethod) => {
      const more = deferred<unknown>();
      const filtered = deferred<unknown>();
      const exported = deferred<unknown>();
      const createObjectURL = vi.fn();
      vi.stubGlobal(
        "URL",
        class extends URL {
          static override createObjectURL = createObjectURL;
        },
      );
      const blob = vi.spyOn(globalThis, "Blob");
      const request = vi.fn((method: string, params: { cursor?: string; query?: string }) => {
        if (method === "transcripts.export") {
          return exported.promise;
        }
        if (method === "transcripts.list") {
          return params.query
            ? filtered.promise
            : Promise.resolve({ sessions: [meetingEntry], nextCursor: null });
        }
        return params.cursor
          ? more.promise
          : Promise.resolve({ ...meetingPage, nextCursor: "more" });
      });
      const { page } = mount(request, "?tab=transcript&selector=meeting");
      await vi.waitFor(() => expect(page.textContent).toContain("Keep the reader quiet"));
      button(page, "Load more").click();
      button(page, "Download Markdown").click();
      const filter = page.querySelector<HTMLInputElement>('input[name="query"]')!;
      filter.value = "filtered";
      filter.form!.dispatchEvent(new Event("submit", { cancelable: true }));
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "transcripts.list",
          expect.objectContaining({ query: "filtered" }),
          expect.anything(),
        ),
      );
      (deniedMethod === "list" ? filtered : exported).reject(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "missing scope: operator.read",
        }),
      );
      await vi.waitFor(() => expect(page.textContent).toContain("Transcript access is restricted"));
      expect(page.textContent).not.toContain("Keep the reader quiet");
      expect(page.textContent).not.toContain(meetingEntry.title);
      more.resolve({ ...meetingPage, utterances: [{ sequence: 1, text: "Late private reader" }] });
      await more.promise;
      await page.updateComplete;
      expect(page.textContent).not.toContain("Late private reader");
      button(page.querySelector(".transcripts-reader")!, "Retry").click();
      await vi.waitFor(() => expect(page.textContent).toContain("Keep the reader quiet"));
      expect(button(page, "Refresh").disabled).toBe(false);
      if (deniedMethod === "export") {
        filtered.resolve({
          sessions: [{ ...meetingEntry, title: "Late private list" }],
          nextCursor: null,
        });
      } else {
        exported.resolve({
          data: btoa("Late private export"),
          filename: "notes.md",
          mimeType: "text/markdown",
        });
      }
      await (deniedMethod === "export" ? filtered.promise : exported.promise);
      await page.updateComplete;
      expect(page.textContent).not.toContain("Late private");
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(blob).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(8);
      expect(button(page, "Refresh").disabled).toBe(false);
      request.mockImplementation(async (method: string) =>
        method === "transcripts.get"
          ? { ...meetingPage, nextCursor: null }
          : { sessions: [meetingEntry], nextCursor: null },
      );
      button(page, "Refresh").click();
      await vi.waitFor(() => expect(page.querySelector(".transcripts-list__entry")).not.toBeNull());
      await vi.waitFor(() =>
        expect(page.querySelectorAll(".transcripts-utterances li")).toHaveLength(1),
      );
      expect(page.textContent).not.toContain("Transcript access is restricted");
    },
  );

  it("keeps the reader Retry available when only the list recovers from an archive denial", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "transcripts.export") {
        throw new GatewayRequestError({ code: "FORBIDDEN", message: "Restricted" });
      }
      return method === "transcripts.get"
        ? meetingPage
        : { sessions: [meetingEntry], nextCursor: null };
    });
    const { page } = mount(request, "?tab=transcript&selector=meeting");
    await vi.waitFor(() => expect(page.textContent).toContain("Keep the reader quiet"));
    button(page, "Download Markdown").click();
    await vi.waitFor(() => expect(page.textContent).toContain("Transcript access is restricted"));
    const filter = page.querySelector<HTMLInputElement>('input[name="query"]')!;
    filter.value = "new filter";
    filter.form!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(page.querySelector(".transcripts-list__entry")).not.toBeNull());
    const reader = page.querySelector(".transcripts-reader")!;
    expect(reader.textContent).not.toContain("Keep the reader quiet");
    expect(reader.textContent).toContain("Transcript access is restricted");
    expect(request.mock.calls.filter(([method]) => method === "transcripts.get")).toHaveLength(2);
    button(reader, "Retry").click();
    await vi.waitFor(() => expect(reader.textContent).toContain("Keep the reader quiet"));
    expect(page.textContent).not.toContain("Transcript access is restricted");
  });

  it.each(
    ["selection", "client", "epoch", "same-args retry"].flatMap((replacement) => [
      ["summary", replacement],
      ["speech", replacement],
    ]),
  )(
    "ignores a denied %s request retired by %s without poisoning the new reader",
    async (readKind, replacement) => {
      const old = deferred<unknown>();
      let readCount = 0;
      const request = vi.fn((method: string, params: { includeUtterances?: boolean }) => {
        if (method === "transcripts.list") {
          return Promise.resolve({ sessions: [], nextCursor: null });
        }
        if (Boolean(params.includeUtterances) !== (readKind === "speech")) {
          return Promise.resolve(meetingPage);
        }
        return ++readCount === 1 ? old.promise : Promise.resolve(meetingPage);
      });
      const { page, snapshot, notify } = mount(request, "?tab=transcript&selector=old");
      await vi.waitFor(() => expect(readCount).toBe(1));
      if (replacement === "selection") {
        page.routeSearch = "?tab=transcript&selector=new";
      } else if (replacement === "client") {
        snapshot.client = { request } as unknown as GatewayBrowserClient;
        notify();
      } else if (replacement === "epoch") {
        snapshot.hello = {
          ...snapshot.hello,
          auth: { role: "operator", scopes: ["operator.admin"] },
        } as ApplicationGatewaySnapshot["hello"];
        notify();
      } else {
        await vi.waitFor(() => expect(button(page, "Refresh").disabled).toBe(false));
        button(page, "Refresh").click();
      }
      await vi.waitFor(() => expect(page.textContent).toContain("Keep the reader quiet"));
      old.reject(new GatewayRequestError({ code: "FORBIDDEN", message: "Old denial" }));
      await old.promise.catch(() => {});
      await page.updateComplete;
      expect(page.textContent).toContain("Keep the reader quiet");
      expect(page.textContent).not.toContain("Transcript access is restricted");
    },
  );

  it("retains reader pages across a transient pagination error and retries the same cursor", async () => {
    const more = deferred<unknown>();
    const request = vi.fn((method: string, params: { cursor?: string }) => {
      if (method === "transcripts.list") {
        return Promise.resolve({ sessions: [], nextCursor: null });
      }
      return params.cursor ? more.promise : Promise.resolve({ ...meetingPage, nextCursor: "more" });
    });
    const { page } = mount(request, "?tab=transcript&selector=meeting");
    await vi.waitFor(() => expect(page.textContent).toContain("Keep the reader quiet"));
    button(page, "Load more").click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "transcripts.get",
        expect.objectContaining({ cursor: "more" }),
        expect.anything(),
      ),
    );
    more.reject(new Error("Temporary network failure"));
    await vi.waitFor(() => expect(page.textContent).toContain("Temporary network failure"));
    expect(page.textContent).toContain("Keep the reader quiet");
    const retry = deferred<unknown>();
    request.mockImplementation(() => retry.promise);
    button(page, "Retry").click();
    await page.updateComplete;
    expect(page.textContent).toContain("Keep the reader quiet");
    expect(request).toHaveBeenLastCalledWith(
      "transcripts.get",
      expect.objectContaining({ cursor: "more" }),
      expect.anything(),
    );
    retry.resolve({
      ...meetingPage,
      utterances: [{ sequence: 1, text: "Complete second page" }],
      nextCursor: null,
    });
    await vi.waitFor(() => expect(page.textContent).toContain("Complete second page"));
    expect(page.querySelectorAll(".transcripts-utterances li")).toHaveLength(2);
  });

  it.each(["success", "denial"])(
    "ignores an export %s after the selected transcript changes",
    async (outcome) => {
      const pending = deferred<unknown>();
      const createObjectURL = vi.fn(() => "blob:transcript");
      const OriginalURL = URL;
      vi.stubGlobal(
        "URL",
        class extends OriginalURL {
          static override createObjectURL = createObjectURL;
          static override revokeObjectURL = vi.fn();
        },
      );
      const request = vi.fn((method: string) => {
        if (method === "transcripts.export") {
          return pending.promise;
        }
        return Promise.resolve(
          method === "transcripts.list" ? { sessions: [], nextCursor: null } : meetingPage,
        );
      });
      const { page } = mount(
        request,
        `?tab=transcript&selector=${encodeURIComponent(meetingEntry.selector)}`,
      );
      await vi.waitFor(() => expect(page.textContent).toContain("Keep the reader quiet"));
      button(page, "Download Markdown").click();
      await vi.waitFor(() => expect(page.textContent).toContain("Preparing download"));
      page.routeSearch = "?tab=transcript&selector=another";
      await page.updateComplete;
      if (outcome === "denial") {
        pending.reject(
          new GatewayRequestError({ code: "FORBIDDEN", message: "Old export denial" }),
        );
      } else {
        pending.resolve({
          selector: meetingEntry.selector,
          filename: "notes.md",
          mimeType: "text/markdown",
          encoding: "base64",
          data: btoa("Private old text"),
          sizeBytes: 16,
        });
      }
      await pending.promise.catch(() => {});
      await page.updateComplete;
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(page.textContent).not.toContain("Transcript access is restricted");
    },
  );

  it("ignores a filtered-list denial from the previous selection", async () => {
    const old = deferred<unknown>();
    const request = vi.fn((method: string, params: { query?: string }) => {
      if (method === "transcripts.get") {
        return Promise.resolve(meetingPage);
      }
      return params.query
        ? old.promise
        : Promise.resolve({ sessions: [meetingEntry], nextCursor: null });
    });
    const { page } = mount(request, "?tab=transcript&selector=meeting");
    await vi.waitFor(() => expect(page.textContent).toContain("Keep the reader quiet"));
    page.routeSearch = "?tab=transcript&selector=meeting&query=filter";
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "transcripts.list",
        expect.objectContaining({ query: "filter" }),
        expect.anything(),
      ),
    );
    request.mockImplementation(async (method: string) =>
      method === "transcripts.get" ? meetingPage : { sessions: [meetingEntry], nextCursor: null },
    );
    page.routeSearch = "?tab=transcript&selector=other&query=filter";
    await vi.waitFor(() => expect(page.querySelector(".transcripts-list__entry")).not.toBeNull());
    old.reject(new GatewayRequestError({ code: "FORBIDDEN", message: "Old filtered list denial" }));
    await old.promise.catch(() => {});
    await page.updateComplete;
    expect(page.textContent).toContain("Keep the reader quiet");
    expect(page.textContent).not.toContain("Transcript access is restricted");
  });

  it("downloads the complete authorized export with its server filename and MIME type", async () => {
    const createObjectURL = vi.fn(() => "blob:transcript");
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = vi.fn();
      },
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe("complete-notes.md");
      });
    const blob = vi.spyOn(globalThis, "Blob");
    const data = "# Synthetic notes\n\nComplete text and stored summary.\n";
    const request = vi.fn(async (method: string) =>
      method === "transcripts.export"
        ? { data: btoa(data), filename: "complete-notes.md", mimeType: "text/markdown" }
        : method === "transcripts.get"
          ? meetingPage
          : { sessions: [], nextCursor: null },
    );
    const { page } = mount(request, "?tab=transcript&selector=meeting");
    await vi.waitFor(() => expect(page.textContent).toContain("Keep the reader quiet"));
    button(page, "Download Markdown").click();
    await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(blob).toHaveBeenCalledOnce();
    const [parts, options] = blob.mock.calls[0]!;
    expect(options).toEqual({ type: "text/markdown" });
    expect(parts).toHaveLength(1);
    expect(new TextDecoder().decode(parts![0] as Uint8Array)).toBe(data);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(page.textContent).toContain("Download started");
  });

  it("bounds the reading window while preserving a way back to the beginning", async () => {
    const request = vi.fn(async (method: string, params: { cursor?: string }) => {
      if (method === "transcripts.list") {
        return { sessions: [], nextCursor: null };
      }
      const pageNumber = Number(params.cursor ?? 0);
      return {
        ...meetingPage,
        utterances: [{ sequence: pageNumber, text: `Utterance ${pageNumber}` }],
        nextCursor: String(pageNumber + 1),
      };
    });
    const { page } = mount(request, "?tab=transcript&selector=long-meeting");
    await vi.waitFor(() => expect(page.textContent).toContain("Utterance 0"));
    for (let pageNumber = 1; pageNumber <= 5; pageNumber++) {
      button(page, "Load more").click();
      await vi.waitFor(() => expect(page.textContent).toContain(`Utterance ${pageNumber}`));
    }
    expect(page.textContent).not.toContain("Utterance 0");
    expect(page.textContent).toContain("Earlier loaded pages");
    button(page, "Read from beginning").click();
    await vi.waitFor(() => expect(page.textContent).toContain("Utterance 0"));
    expect(page.textContent).not.toContain("Utterance 5");
  });

  it("converts date controls to the protocol's inclusive/exclusive UTC boundaries", () => {
    expect(transcriptListParams("?startedAfter=2026-08-01&startedBefore=2026-09-01")).toMatchObject(
      {
        startedAfter: "2026-08-01T00:00:00.000Z",
        startedBefore: "2026-09-01T00:00:00.000Z",
        limit: 50,
      },
    );
  });
});
