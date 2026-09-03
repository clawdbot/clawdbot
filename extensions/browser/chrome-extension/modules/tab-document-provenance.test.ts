import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import type { TabAccessEpoch, TabAccessPolicy } from "./tab-access.js";
import type { BrowserTabSnapshot } from "./tab-eligibility.js";

type TabDocumentNavigation = {
  readonly confirmed: boolean;
  observe(event: Record<string, unknown>, send: (event: Record<string, unknown>) => void): void;
  accept(result: unknown): void;
};

type TabDocumentAccess = {
  readonly fileAccessAllowed: boolean;
  invalidateTab(tabId: number): void;
  requireTab(
    tabId: number,
    epoch: TabAccessEpoch,
    afterNavigation?: boolean,
  ): Promise<BrowserTabSnapshot>;
  provenTabIsCurrent(tabId: number, epoch: TabAccessEpoch): boolean;
  recordRootCommit(tabId: number, url: string): void;
};

type TabDocumentProvenance = Pick<TabAccessPolicy, "forwardDocumentEvent" | "navigateTab"> & {
  get(tabId: number): { navigation: TabDocumentNavigation } | undefined;
  rootRevision(tabId: number): number;
  observeTab(tab: BrowserTabSnapshot | undefined): void;
  revokeDocument(tabId: number): void;
  retireAttachment: TabAccessPolicy["retireTabDocument"];
  invalidateAll(): void;
  invalidateGroup(group?: { id: number }): void;
};

type TabDocumentProvenanceModule = {
  createTabDocumentProvenance: (options: { access: TabDocumentAccess }) => TabDocumentProvenance;
};

// Browser-serialized modules remain plain JavaScript. Keep test-only typing local
// so direct owner coverage does not alter the packaged resolution topology.
const { createTabDocumentProvenance } = await vi.importActual<TabDocumentProvenanceModule>(
  "./tab-document-provenance.js",
);

const originalUrl = "https://example.com/existing";
const blankResult = { frameId: "root", loaderId: "blank-loader" };
const blankFrame = { id: "root", loaderId: "blank-loader", url: "about:blank" };
const frameEvent = (frame = blankFrame, sessionId?: string) => ({
  type: "cdpEvent",
  tabId: 7,
  ...(sessionId ? { sessionId } : {}),
  method: "Page.frameNavigated",
  params: { frame },
});
const contextEvent = {
  type: "cdpEvent",
  tabId: 7,
  method: "Runtime.executionContextsCleared",
  params: {},
};

function createHarness() {
  const epoch: TabAccessEpoch = { revision: 1, groupRevision: 0, tabRevision: 1 };
  const attachmentEpoch: TabAccessEpoch = { revision: 1, groupRevision: 0, tabRevision: 2 };
  const proven = new Set([epoch, attachmentEpoch]);
  const isAttached = vi.fn<() => TabAccessEpoch | undefined>(() => attachmentEpoch);
  const isCurrent = vi.fn(() => true);
  const tab: BrowserTabSnapshot = { id: 7, url: originalUrl, groupId: 7, windowId: 1 };
  const access = {
    fileAccessAllowed: false,
    provenTabIsCurrent: (tabId: number, candidate: TabAccessEpoch) =>
      tabId === 7 && proven.has(candidate),
    requireTab: vi.fn(async () => tab),
    recordRootCommit: vi.fn(),
    invalidateTab: vi.fn((tabId: number) => {
      proven.clear();
      documents.revokeDocument(tabId);
    }),
  } satisfies TabDocumentAccess;
  const documents = createTabDocumentProvenance({ access });
  const send = vi.fn();
  const tree = { frameTree: { frame: { id: "root", loaderId: "original", url: originalUrl } } };
  const sendCommand = vi.fn(
    async (_method: string, _params: Record<string, unknown>): Promise<unknown> => tree,
  );
  const emit = (event: Record<string, unknown>) => documents.forwardDocumentEvent(event, send);
  const commitBlank = () => {
    tab.url = "about:blank";
    documents.observeTab(tab);
    emit(contextEvent);
    emit(frameEvent());
  };
  const navigate = (
    native = async (): Promise<unknown> => blankResult,
    params = { url: "about:blank", frameId: "root" },
  ) => {
    sendCommand.mockImplementation(async (method) =>
      method === "Page.getFrameTree" ? tree : await native(),
    );
    return documents.navigateTab(7, epoch, params, isAttached, isCurrent, sendCommand);
  };
  return {
    documents,
    access,
    epoch,
    attachmentEpoch,
    proven,
    isAttached,
    isCurrent,
    tab,
    tree,
    send,
    sendCommand,
    emit,
    commitBlank,
    navigate,
  };
}

describe("commanded tab document provenance", () => {
  it.each(["before response", "after response"])(
    "flushes ordered native events only when the root commits %s",
    async (order) => {
      const h = createHarness();
      h.tab.url += "#section";
      Object.assign(h.tree.frameTree.frame, { urlFragment: "#section" });
      await expect(
        h.navigate(async () => {
          if (order === "before response") {
            h.commitBlank();
          }
          expect(h.send).not.toHaveBeenCalled();
          expect(h.documents.get(7)?.navigation.confirmed).toBe(false);
          return blankResult;
        }),
      ).resolves.toEqual(blankResult);
      if (order === "after response") {
        expect(h.documents.get(7)?.navigation.confirmed).toBe(false);
        h.commitBlank();
      }
      expect(h.documents.get(7)?.navigation.confirmed).toBe(true);
      expect(h.send.mock.calls).toEqual([[contextEvent], [frameEvent()]]);
      const trace = {
        ...contextEvent,
        method: "Tracing.tracingComplete",
        params: { stream: "trace" },
      };
      h.emit(trace);
      expect(h.send.mock.calls).toEqual([[contextEvent], [frameEvent()], [trace]]);
      expect(h.access.recordRootCommit).toHaveBeenCalledExactlyOnceWith(7, "about:blank");
    },
  );

  it.each([
    { name: "source fragment disagreement", frame: { urlFragment: "#other" } },
    { name: "child root tree", frame: { parentId: "parent" } },
    { name: "missing root id", frame: { id: "" } },
    { name: "source URL disagreement", frame: { url: "https://other.example/" } },
  ])("rejects preflight $name", async ({ frame }) => {
    const h = createHarness();
    Object.assign(h.tree.frameTree.frame, frame);
    await expect(h.navigate()).rejects.toThrow("current authorized root document");
    expect(h.sendCommand).toHaveBeenCalledExactlyOnceWith("Page.getFrameTree", {});
    expect(h.documents.get(7)).toBeUndefined();
  });

  it("does not mint provenance for a caller-constrained child frame", async () => {
    const h = createHarness();
    const params = { url: "about:blank", frameId: "child" };
    await expect(h.navigate(async () => blankResult, params)).resolves.toEqual(blankResult);
    expect(h.sendCommand).toHaveBeenLastCalledWith("Page.navigate", params);
    expect(h.documents.get(7)).toBeUndefined();
  });

  it.each(["child frame", "child session", "wrong root", "uncommanded fragment"])(
    "does not accept %s as root proof",
    async (source) => {
      const h = createHarness();
      const event = frameEvent(
        {
          ...blankFrame,
          ...(source === "child frame" ? { parentId: "parent" } : {}),
          ...(source === "wrong root" ? { id: "other" } : {}),
          ...(source === "uncommanded fragment" ? { urlFragment: "#other" } : {}),
        },
        source === "child session" ? "child" : undefined,
      );
      const navigating = h.navigate(async () => {
        h.emit(event);
        return blankResult;
      });
      if (source === "child frame" || source === "child session") {
        await expect(navigating).resolves.toEqual(blankResult);
        expect(h.documents.get(7)?.navigation.confirmed).toBe(false);
        expect(h.documents.rootRevision(7)).toBe(0);
        expect(h.access.recordRootCommit).not.toHaveBeenCalled();
        expect(h.send).not.toHaveBeenCalled();
        h.documents.invalidateAll();
      } else {
        await expect(navigating).rejects.toThrow("access was revoked");
      }
      expect(h.documents.get(7)).toBeUndefined();
      expect(h.send).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "wrong frame", result: { ...blankResult, frameId: "child" } },
    { name: "wrong loader", result: { ...blankResult, loaderId: "other" } },
    { name: "missing loader", result: { frameId: "root" } },
    { name: "aborted", result: { ...blankResult, errorText: "net::ERR_ABORTED" } },
    { name: "download", result: { ...blankResult, isDownload: true } },
    { name: "rejected", result: blankResult },
    { name: "competing commit", result: blankResult },
  ])("discards early events after native $name", async ({ name, result }) => {
    const h = createHarness();
    await expect(
      h.navigate(async () => {
        h.commitBlank();
        if (name === "rejected") {
          throw new Error("native failure");
        }
        if (name === "competing commit") {
          h.emit(frameEvent({ ...blankFrame, loaderId: "competitor" }));
        }
        return result;
      }),
    ).rejects.toThrow(name === "rejected" ? "native failure" : /confirm|revoked/);
    expect(h.documents.get(7)).toBeUndefined();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.access.invalidateTab).toHaveBeenCalledWith(7);
  });

  it.each(["wrong loader", "missing loader", "competing document"])(
    "revokes a responded navigation on %s",
    async (change) => {
      const h = createHarness();
      await h.navigate();
      h.emit(contextEvent);
      h.emit(
        frameEvent({
          ...blankFrame,
          loaderId: change === "missing loader" ? "" : "other",
          url: change === "competing document" ? originalUrl : "about:blank",
        }),
      );
      expect(h.documents.get(7)).toBeUndefined();
      expect(h.send).not.toHaveBeenCalled();
    },
  );

  it.each(
    ["before response", "after confirmation"].flatMap((phase) =>
      [
        "connection",
        "attachment",
        "command access",
        "attachment access",
        "retireAttachment",
        "invalidateAll",
        "invalidateGroup",
      ].map((reason) => ({ phase, reason })),
    ),
  )("discards authority and queued events on $reason $phase", async ({ phase, reason }) => {
    const h = createHarness();
    let navigation: TabDocumentNavigation;
    const revoke = () => {
      switch (reason) {
        case "connection":
          h.isCurrent.mockReturnValue(false);
          break;
        case "attachment":
          h.isAttached.mockReturnValue(undefined);
          break;
        case "command access":
          h.proven.delete(h.epoch);
          break;
        case "attachment access":
          h.proven.delete(h.attachmentEpoch);
          break;
        case "retireAttachment":
          h.documents.retireAttachment(7);
          break;
        case "invalidateAll":
          h.documents.invalidateAll();
          break;
        default:
          h.documents.invalidateGroup({ id: 7 });
      }
    };
    const navigating = h.navigate(async () => {
      h.commitBlank();
      const document = h.documents.get(7);
      assert(document);
      navigation = document.navigation;
      if (phase === "before response") {
        revoke();
      }
      return blankResult;
    });
    if (phase === "before response") {
      await expect(navigating).rejects.toThrow("access was revoked");
    } else {
      await navigating;
      h.send.mockClear();
      revoke();
      expect(() => navigation.observe(contextEvent, h.send)).toThrow("access was revoked");
    }
    h.isCurrent.mockReturnValue(true);
    h.isAttached.mockReturnValue(h.attachmentEpoch);
    h.proven.add(h.epoch).add(h.attachmentEpoch);
    expect(() => navigation.accept(blankResult)).toThrow("access was revoked");
    expect(() => navigation.observe(contextEvent, h.send)).toThrow("access was revoked");
    expect(h.documents.get(7)).toBeUndefined();
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each([
    { name: "group move", tab: { groupId: -1 } },
    { name: "window move", tab: { windowId: 2 } },
    { name: "incognito", tab: { incognito: true } },
    { name: "file pending", tab: { pendingUrl: "file:///tmp/fixture" } },
    { name: "internal pending", tab: { pendingUrl: "chrome://settings" } },
    { name: "restricted document", tab: { url: "chrome://settings" } },
    { name: "lookalike blank", tab: { url: "about:blank#other" } },
    { name: "user blank", tab: {} },
    { name: "lost currentness", tab: {} },
  ])("retires controlled blank on $name", async ({ name, tab }) => {
    const h = createHarness();
    await h.navigate(async () => {
      h.commitBlank();
      return blankResult;
    });
    const document = h.documents.get(7);
    assert(document);
    const navigation = document.navigation;
    h.send.mockClear();
    if (name === "lost currentness") {
      h.isCurrent.mockReturnValue(false);
    }
    if (name === "user blank") {
      h.emit(frameEvent({ ...blankFrame, loaderId: "user" }));
    } else {
      h.documents.observeTab(Object.assign(h.tab, tab));
    }
    expect(h.documents.get(7)).toBeUndefined();
    expect(h.access.invalidateTab).toHaveBeenCalledWith(7);
    expect(() => navigation.observe(contextEvent, h.send)).toThrow("access was revoked");
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each(["root commit", "attachment revision", "access revision"])(
    "rejects a preflight overtaken by %s",
    async (change) => {
      const h = createHarness();
      const navigating = h.navigate();
      if (change === "root commit") {
        h.emit(frameEvent({ ...blankFrame, url: originalUrl }));
      } else if (change === "attachment revision") {
        h.documents.retireAttachment(7);
      } else {
        h.proven.delete(h.epoch);
      }
      await expect(navigating).rejects.toThrow("current authorized root document");
      expect(h.sendCommand).toHaveBeenCalledExactlyOnceWith("Page.getFrameTree", {});
      expect(h.documents.get(7)).toBeUndefined();
    },
  );

  it.each(
    ["event count", "event bytes"].flatMap((limit) =>
      [false, true].map((overflow) => ({ limit, overflow })),
    ),
  )("bounds native $limit exactly (overflow=$overflow)", async ({ limit, overflow }) => {
    const h = createHarness();
    const events: Record<string, unknown>[] = [frameEvent()];
    if (limit === "event count") {
      for (let index = 1; index < 128 + Number(overflow); index++) {
        events.push({ ...contextEvent, params: { index } });
      }
    } else {
      const event = { ...contextEvent, params: { value: "" } };
      const overhead = JSON.stringify(events[0]).length + JSON.stringify(event).length;
      event.params.value = "x".repeat(256 * 1024 - overhead + Number(overflow));
      events.push(event);
    }
    const navigating = h.navigate(async () => {
      for (const event of events) {
        h.emit(event);
      }
      expect(h.send).not.toHaveBeenCalled();
      return blankResult;
    });
    if (overflow) {
      await expect(navigating).rejects.toThrow("access was revoked");
      expect(h.documents.get(7)).toBeUndefined();
      expect(h.send).not.toHaveBeenCalled();
    } else {
      await expect(navigating).resolves.toEqual(blankResult);
      expect(h.documents.get(7)?.navigation.confirmed).toBe(true);
      expect(h.send.mock.calls.map(([event]) => event)).toEqual(events);
    }
  });

  it("stops flushing immediately when the receiver revokes attachment authority", async () => {
    const h = createHarness();
    h.send.mockImplementationOnce(() => h.documents.retireAttachment(7));
    await expect(
      h.navigate(async () => {
        h.commitBlank();
        return blankResult;
      }),
    ).rejects.toThrow("access was revoked");
    expect(h.send.mock.calls).toEqual([[contextEvent]]);
    expect(h.documents.get(7)).toBeUndefined();
  });

  it("scopes group invalidation and never restores retired documents in a fresh instance", async () => {
    const h = createHarness();
    await h.navigate(async () => {
      h.commitBlank();
      return blankResult;
    });
    h.documents.invalidateGroup({ id: 8 });
    expect(h.documents.get(7)?.navigation.confirmed).toBe(true);
    h.documents.invalidateGroup();
    expect(h.documents.get(7)).toBeUndefined();
    const fresh = createTabDocumentProvenance({ access: h.access });
    expect(fresh.get(7)).toBeUndefined();
    expect(fresh.rootRevision(7)).toBe(0);
    expect(h.documents.rootRevision(7)).toBe(1);
  });
});
