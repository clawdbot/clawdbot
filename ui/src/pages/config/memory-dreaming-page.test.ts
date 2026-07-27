/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./memory-dreaming-page.ts";

type DreamingPageElement = HTMLElement & { updateComplete: Promise<unknown> };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Drives the capability probe directly: `lookupSchemaPath` is the only call the
 * probe makes, so handing each invocation its own promise lets a test settle an
 * older probe after a newer one.
 */
function createPage(params: {
  lookupSchemaPath: (call: number) => Promise<unknown>;
  configObject?: Record<string, unknown>;
}) {
  let lookups = 0;
  const lookupSchemaPath = vi.fn(() => params.lookupSchemaPath(lookups++));
  const listeners = new Set<() => void>();
  const runtimeConfig = {
    state: {
      client: {},
      connected: true,
      configSaving: false,
      configApplying: false,
      configForm: params.configObject ?? {},
      configSnapshot: null,
    },
    subscribe: (notify: () => void) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    lookupSchemaPath,
    patchForm: vi.fn(),
    removeFormValue: vi.fn(),
  };
  const element = document.createElement("openclaw-memory-dreaming") as DreamingPageElement;
  (element as unknown as { context: ApplicationContext }).context = {
    runtimeConfig,
    agents: {
      state: { agentsList: [], agentsLoading: false },
      subscribe: () => () => undefined,
      ensureList: () => Promise.resolve(),
    },
  } as unknown as ApplicationContext;
  const setConnected = (connected: boolean) => {
    runtimeConfig.state = { ...runtimeConfig.state, connected };
    for (const notify of listeners) {
      notify();
    }
  };
  return { element, lookupSchemaPath, setConnected };
}

describe("MemoryDreamingSettings capability probe", () => {
  it("re-probes after a reconnect instead of trusting the in-flight lookup", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const { element, lookupSchemaPath, setConnected } = createPage({
      lookupSchemaPath: (call) => (call === 0 ? first.promise : second.promise),
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(lookupSchemaPath).toHaveBeenCalledTimes(1));

      // The slot owner is unchanged across the drop, so a plugin-id token would
      // still read as "already in flight" and swallow this retry.
      setConnected(false);
      setConnected(true);
      await waitForFast(() => expect(lookupSchemaPath).toHaveBeenCalledTimes(2));

      // The abandoned probe must not decide the answer it was never asked for.
      first.resolve({ type: "object", additionalProperties: false, properties: {} });
      await first.promise;
      await element.updateComplete;
      expect(element.textContent).not.toContain("does not support");
    } finally {
      element.remove();
    }
  });
});
