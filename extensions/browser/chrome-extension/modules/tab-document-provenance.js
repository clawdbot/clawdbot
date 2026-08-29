import { tabEligibility } from "./tab-eligibility.js";

function frameDocumentUrl(frame) {
  // CDP splits the fragment from its URL; Chrome tabs expose the complete URL.
  return `${frame.url}${frame.urlFragment ?? ""}`;
}

/** Commanded document provenance never owns tab deletion or URL restoration. */
export function createTabDocumentProvenance({ access }) {
  const documents = new Map();
  const lifetimes = new Map();

  function lifecycle(tabId) {
    let value = lifetimes.get(tabId);
    if (!value) {
      value = { root: 0, attachment: 0 };
      lifetimes.set(tabId, value);
    }
    return value;
  }

  function revokeDocument(tabId) {
    const document = documents.get(tabId);
    documents.delete(tabId);
    document?.navigation.cancel();
  }

  function commitTabDocument(tabId, url) {
    const document = documents.get(tabId);
    if (!document || url === "about:blank") {
      return;
    }
    if (document.navigation.confirmed) {
      documents.delete(tabId);
    } else {
      access.invalidateTab(tabId);
    }
  }

  function observeTab(tab) {
    const document = documents.get(tab?.id);
    if (!document) {
      return;
    }
    if (tab.url && document.navigation.confirmed) {
      commitTabDocument(tab.id, tab.url);
    }
    if (
      !document.isCurrent() ||
      tab.groupId !== document.groupId ||
      tab.windowId !== document.windowId ||
      !tabEligibility(tab, {
        fileAccessAllowed: access.fileAccessAllowed,
        controlledBlank: true,
      }).eligible
    ) {
      access.invalidateTab(tab.id);
    }
  }

  async function navigateTab(tabId, epoch, params, isAttached, isConnectionCurrent, sendCommand) {
    // Only the authenticated command owner calls this with native callbacks.
    // The caller's frame id is a constraint, never root-frame evidence.
    const attachmentEpoch = isAttached();
    const attachment = lifecycle(tabId).attachment;
    const current = () =>
      isConnectionCurrent() &&
      isAttached() &&
      lifecycle(tabId).attachment === attachment &&
      access.provenTabIsCurrent(tabId, epoch) &&
      access.provenTabIsCurrent(tabId, attachmentEpoch);
    if (!attachmentEpoch || !current()) {
      throw new Error(`tab ${tabId} access was revoked`);
    }
    const root = lifecycle(tabId).root;
    const tree = await sendCommand("Page.getFrameTree", {});
    const tab = await access.requireTab(tabId, epoch);
    const frame = tree?.frameTree?.frame;
    if (
      !current() ||
      root !== lifecycle(tabId).root ||
      !frame?.id ||
      frame.parentId ||
      frameDocumentUrl(frame) !== tab.url ||
      documents.has(tabId)
    ) {
      throw new Error("Navigation requires the current authorized root document");
    }
    if (params.frameId !== undefined && params.frameId !== frame.id) {
      return await sendCommand("Page.navigate", params);
    }
    const document = {
      controlledBlank: true,
      groupId: tab.groupId,
      windowId: tab.windowId,
      isCurrent: current,
      navigation: undefined,
    };
    const navigation = createDocumentNavigation({
      frameId: frame.id,
      isCurrent: () => documents.get(tabId) === document && current(),
      revoke: () => {
        if (documents.get(tabId) === document) {
          documents.delete(tabId);
          access.invalidateTab(tabId);
        }
      },
    });
    document.navigation = navigation;
    documents.set(tabId, document);
    try {
      navigation.assertCurrent();
      const result = await sendCommand("Page.navigate", params);
      await access.requireTab(tabId, epoch, true);
      navigation.accept(result);
      return result;
    } catch (error) {
      navigation.cancel();
      throw error;
    }
  }

  function forwardDocumentEvent(event, send) {
    const document = documents.get(event.tabId);
    const root =
      !event.sessionId &&
      event.method === "Page.frameNavigated" &&
      !event.params?.frame?.parentId &&
      typeof event.params?.frame?.url === "string";
    const frameUrl = root ? frameDocumentUrl(event.params.frame) : undefined;
    if (root) {
      lifecycle(event.tabId).root += 1;
      access.recordRootCommit(event.tabId, frameUrl);
    }
    if (document) {
      if (
        root &&
        document.navigation.confirmed &&
        event.params.frame.id === document.navigation.frameId &&
        frameUrl !== "about:blank"
      ) {
        commitTabDocument(event.tabId, frameUrl);
      } else {
        try {
          document.navigation.observe(event, send);
        } catch {
          // Revocation discards queued native events; it never reauthorizes them.
        }
        return;
      }
    } else if (root) {
      commitTabDocument(event.tabId, frameUrl);
    }
    send(event);
  }

  return {
    get: (tabId) => documents.get(tabId),
    rootRevision: (tabId) => lifecycle(tabId).root,
    observeTab,
    revokeDocument,
    retireAttachment: (tabId) => {
      lifecycle(tabId).attachment += 1;
      if (documents.has(tabId)) {
        access.invalidateTab(tabId);
      }
    },
    invalidateAll: () => {
      for (const tabId of documents.keys()) {
        revokeDocument(tabId);
      }
    },
    invalidateGroup: (group) => {
      for (const [tabId, document] of documents) {
        if (!group || document.groupId === group.id) {
          access.invalidateTab(tabId);
        }
      }
    },
    navigateTab,
    forwardDocumentEvent,
  };
}

// A blank navigation can commit before Page.navigate returns its loader id.
// Retain only bounded native events until the command and root commit agree;
// revocation discards them without replay or URL restoration.
const MAX_PENDING_EVENTS = 128;
const MAX_PENDING_BYTES = 256 * 1024;

function createDocumentNavigation({ frameId, isCurrent, revoke }) {
  let state = { kind: "pending", events: [], bytes: 0, commit: undefined };

  const fail = () => {
    state = { kind: "revoked" };
    revoke();
  };
  const assertCurrent = () => {
    if (state.kind === "revoked" || !isCurrent()) {
      fail();
      throw new Error("Document navigation access was revoked");
    }
  };
  const flush = (loaderId, events) => {
    assertCurrent();
    state = { kind: "blank", loaderId };
    for (const { event, send } of events) {
      assertCurrent();
      send(event);
    }
  };

  return {
    frameId,
    get confirmed() {
      return state.kind === "blank";
    },
    cancel: fail,
    assertCurrent,
    observe(event, send) {
      assertCurrent();
      const frame =
        !event.sessionId && event.method === "Page.frameNavigated"
          ? event.params?.frame
          : undefined;
      if (frame && !frame.parentId) {
        if (frame.id !== frameId || frameDocumentUrl(frame) !== "about:blank" || !frame.loaderId) {
          fail();
          return;
        }
        if (state.kind === "blank") {
          if (state.loaderId !== frame.loaderId) {
            fail();
            return;
          }
        } else if (state.kind === "pending") {
          if (state.commit && state.commit !== frame.loaderId) {
            fail();
            return;
          }
          state.commit = frame.loaderId;
        } else if (state.kind === "responded" && state.loaderId !== frame.loaderId) {
          fail();
          return;
        }
      }
      if (state.kind === "blank") {
        send(event);
        return;
      }
      const bytes = JSON.stringify(event).length;
      if (state.events.length >= MAX_PENDING_EVENTS || state.bytes + bytes > MAX_PENDING_BYTES) {
        fail();
        return;
      }
      state.events.push({ event, send });
      state.bytes += bytes;
      if (state.kind === "responded" && frame && !frame.parentId) {
        flush(state.loaderId, state.events);
      }
    },
    accept(result) {
      assertCurrent();
      if (
        state.kind !== "pending" ||
        result?.frameId !== frameId ||
        typeof result.loaderId !== "string" ||
        !result.loaderId ||
        result.errorText ||
        result.isDownload ||
        (state.commit && state.commit !== result.loaderId)
      ) {
        fail();
        throw new Error("Native navigation did not confirm the commanded root document");
      }
      if (state.commit) {
        flush(result.loaderId, state.events);
      } else {
        state = {
          kind: "responded",
          loaderId: result.loaderId,
          events: state.events,
          bytes: state.bytes,
        };
      }
    },
  };
}
