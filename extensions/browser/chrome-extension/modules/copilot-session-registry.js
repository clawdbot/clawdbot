const LOCAL_KEY = "copilotSessionRegistryV1";
const INSTANCE_KEY = "copilotBrowserInstanceV1";
const PANEL_BINDINGS_KEY = "copilotPanelBindingsV1";

function emptyState() {
  return { sessions: {}, pendingArchives: [] };
}

/** Browser-instance-only capabilities bind same-path panel documents to tabs. */
export class CopilotPanelBindingRegistry {
  constructor(storage = chrome.storage.session) {
    this.storage = storage;
    this.byTab = {};
    this.ready = null;
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    if (!this.ready) {
      this.ready = (async () => {
        const stored = (await this.storage.get([PANEL_BINDINGS_KEY]))[PANEL_BINDINGS_KEY];
        this.byTab = stored && typeof stored === "object" ? stored : {};
      })();
    }
    await this.ready;
  }

  async bind(tabId) {
    await this.initialize();
    let token;
    this.writeChain = this.writeChain.then(async () => {
      const current = this.byTab[String(tabId)];
      if (typeof current === "string" && current) {
        token = current;
        return;
      }
      token = crypto.randomUUID();
      this.byTab[String(tabId)] = token;
      await this.storage.set({ [PANEL_BINDINGS_KEY]: this.byTab });
    });
    await this.writeChain;
    return token;
  }

  async resolve(token) {
    await this.initialize();
    for (const [rawTabId, candidate] of Object.entries(this.byTab)) {
      if (candidate === token) {
        return Number(rawTabId);
      }
    }
    return null;
  }

  async remove(tabId) {
    await this.initialize();
    await this.#mutate(() => {
      delete this.byTab[String(tabId)];
    });
  }

  async #mutate(run) {
    this.writeChain = this.writeChain.then(async () => {
      run();
      await this.storage.set({ [PANEL_BINDINGS_KEY]: this.byTab });
    });
    await this.writeChain;
  }
}

/** Durable registry: worker suspension preserves bindings; browser restart archives orphans. */
export class CopilotSessionRegistry {
  constructor(storage = chrome.storage) {
    this.storage = storage;
    this.state = emptyState();
    this.instanceId = null;
    this.ready = null;
    this.writeChain = Promise.resolve();
  }

  async initialize(existingTabIds) {
    if (this.ready) {
      return await this.ready;
    }
    this.ready = this.#initialize(existingTabIds);
    return await this.ready;
  }

  async #initialize(existingTabIds) {
    const sessionStored = await this.storage.session.get([INSTANCE_KEY]);
    this.instanceId = sessionStored[INSTANCE_KEY];
    if (typeof this.instanceId !== "string" || !this.instanceId) {
      this.instanceId = crypto.randomUUID();
      await this.storage.session.set({ [INSTANCE_KEY]: this.instanceId });
    }
    const localStored = await this.storage.local.get([LOCAL_KEY]);
    const candidate = localStored[LOCAL_KEY];
    this.state =
      candidate && typeof candidate === "object"
        ? {
            sessions:
              candidate.sessions && typeof candidate.sessions === "object"
                ? candidate.sessions
                : {},
            pendingArchives: Array.isArray(candidate.pendingArchives)
              ? candidate.pendingArchives
              : [],
          }
        : emptyState();
    for (const [rawTabId, entry] of Object.entries(this.state.sessions)) {
      const tabId = Number(rawTabId);
      if (entry?.browserInstanceId === this.instanceId && existingTabIds.has(tabId)) {
        continue;
      }
      this.#queueArchive(entry);
      delete this.state.sessions[rawTabId];
    }
    await this.#persist();
    return this.instanceId;
  }

  get(tabId, gatewayScope) {
    const entry = this.state.sessions[String(tabId)] ?? null;
    return entry?.gatewayScope === gatewayScope ? entry : null;
  }

  list() {
    return Object.values(this.state.sessions);
  }

  gatewayScopes() {
    return [
      ...new Set([
        ...this.list().map((entry) => entry.gatewayScope),
        ...this.state.pendingArchives.map((entry) => entry.gatewayScope),
      ]),
    ].filter((scope) => typeof scope === "string" && scope);
  }

  pendingArchives(gatewayScope) {
    return this.state.pendingArchives.filter((entry) => entry.gatewayScope === gatewayScope);
  }

  async put(tabId, entry) {
    await this.#mutate(() => {
      const current = this.state.sessions[String(tabId)];
      if (current && current.gatewayScope !== entry.gatewayScope) {
        // The write chain transfers old-scope custody to the durable archive
        // queue before replacement, so concurrent recovery cannot lose it.
        this.#queueArchive(current);
      }
      this.state.sessions[String(tabId)] = {
        ...entry,
        tabId,
        browserInstanceId: this.instanceId,
      };
    });
    return this.get(tabId, entry.gatewayScope);
  }

  async updateBinding(tabId, gatewayScope, binding) {
    await this.#mutate(() => {
      const current = this.get(tabId, gatewayScope);
      if (current) {
        current.binding = { ...binding };
      }
    });
  }

  async confirmSession(tabId, gatewayScope, sessionId) {
    await this.#mutate(() => {
      const current = this.get(tabId, gatewayScope);
      if (!current) {
        return;
      }
      if (typeof sessionId === "string" && sessionId) {
        current.sessionId = sessionId;
      }
      delete current.provisional;
      delete current.creationPending;
    });
    return this.get(tabId, gatewayScope);
  }

  async markSessionCreationPending(tabId, gatewayScope) {
    await this.#mutate(() => {
      const current = this.get(tabId, gatewayScope);
      if (current?.provisional) {
        current.creationPending = true;
      }
    });
    return this.get(tabId, gatewayScope);
  }

  async discardProvisionalSession(tabId, gatewayScope) {
    let discarded = false;
    await this.#mutate(() => {
      const current = this.get(tabId, gatewayScope);
      if (!current?.provisional) {
        return;
      }
      delete this.state.sessions[String(tabId)];
      discarded = true;
    });
    return discarded;
  }

  async startRun(tabId, gatewayScope, runId) {
    let started = null;
    await this.#mutate(() => {
      const current = this.get(tabId, gatewayScope);
      if (!current || current.activeRunId) {
        return;
      }
      current.activeRunId = runId;
      current.abortPending = false;
      started = current;
    });
    return started;
  }

  async queueAbort(tabId, gatewayScope) {
    let queued = null;
    await this.#mutate(() => {
      const current = this.get(tabId, gatewayScope);
      if (!current?.activeRunId) {
        return;
      }
      current.abortPending = true;
      queued = current;
    });
    return queued;
  }

  async queueActiveAborts(gatewayScope) {
    await this.#mutate(() => {
      for (const entry of Object.values(this.state.sessions)) {
        if (entry?.gatewayScope === gatewayScope && entry.activeRunId) {
          entry.abortPending = true;
        }
      }
    });
  }

  pendingAborts(gatewayScope) {
    return this.list().filter(
      (entry) => entry.gatewayScope === gatewayScope && entry.activeRunId && entry.abortPending,
    );
  }

  async finishRun(gatewayScope, sessionKey, runId) {
    let finished = false;
    await this.#mutate(() => {
      const current = this.list().find(
        (entry) => entry.gatewayScope === gatewayScope && entry.sessionKey === sessionKey,
      );
      if (!current || current.activeRunId !== runId) {
        return;
      }
      delete current.activeRunId;
      delete current.abortPending;
      finished = true;
    });
    return finished;
  }

  async closeTab(tabId) {
    let closed = null;
    await this.#mutate(() => {
      closed = this.state.sessions[String(tabId)] ?? null;
      if (closed) {
        this.#queueArchive(closed);
        delete this.state.sessions[String(tabId)];
      }
    });
    return closed;
  }

  async closeScope(gatewayScope) {
    await this.#mutate(() => {
      for (const [rawTabId, entry] of Object.entries(this.state.sessions)) {
        if (entry?.gatewayScope !== gatewayScope) {
          continue;
        }
        this.#queueArchive(entry);
        delete this.state.sessions[rawTabId];
      }
    });
  }

  async closeInactiveScope(gatewayScope) {
    await this.#mutate(() => {
      for (const [rawTabId, entry] of Object.entries(this.state.sessions)) {
        if (entry?.gatewayScope !== gatewayScope || entry.activeRunId) {
          continue;
        }
        this.#queueArchive(entry);
        delete this.state.sessions[rawTabId];
      }
    });
  }

  async resolveArchive(gatewayScope, sessionKey) {
    await this.#mutate(() => {
      this.state.pendingArchives = this.state.pendingArchives.filter(
        (entry) => entry.gatewayScope !== gatewayScope || entry.sessionKey !== sessionKey,
      );
    });
  }

  #queueArchive(entry) {
    if (!entry?.sessionKey || !entry?.gatewayScope) {
      return;
    }
    if (entry.provisional && entry.creationPending !== true) {
      return;
    }
    const existing = this.state.pendingArchives.some(
      (candidate) =>
        candidate.gatewayScope === entry.gatewayScope && candidate.sessionKey === entry.sessionKey,
    );
    if (!existing) {
      this.state.pendingArchives.push({
        gatewayScope: entry.gatewayScope,
        sessionKey: entry.sessionKey,
        sessionId: entry.sessionId,
        tabId: entry.tabId,
        ensureCreated: entry.provisional === true,
        queuedAt: Date.now(),
      });
    }
  }

  async #mutate(run) {
    this.writeChain = this.writeChain.then(async () => {
      run();
      await this.#persist();
    });
    await this.writeChain;
  }

  async #persist() {
    await this.storage.local.set({ [LOCAL_KEY]: this.state });
  }
}
