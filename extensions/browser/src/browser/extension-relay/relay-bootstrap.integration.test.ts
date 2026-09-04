import vm from "node:vm";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, expect, it, vi } from "vitest";
import { createRelayCommandHandler } from "../../../chrome-extension/modules/relay-command-handler.js";
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
  stopBrowserControlService,
} from "../../control-service.js";
import { executeActViaPlaywright } from "../pw-tools-core.interactions.execution.js";
import { withConnectedDaemon } from "./relay-coexistence.test-support.js";

afterEach(async () => {
  await stopBrowserControlService();
  clearRuntimeConfigSnapshot();
  vi.unstubAllGlobals();
});

it.each(["owned", "borrowed"] as const)(
  "evaluates after tabs when the %s relay delays the frame-tree post-access reply",
  async (ownership) => {
    const frameTreeHeld = createDeferred<void>();
    const releaseFrameTree = createDeferred<void>();
    const laterCommand = createDeferred<void>();
    const methods = new WeakMap<object, { method?: string; checks: number }>();
    const realm = vm.createContext({});
    const objects = new Map<string, unknown>();
    const evaluated: unknown[] = [];
    let send: (message: Record<string, unknown>) => void;
    const event = (context: Record<string, unknown>) =>
      send({
        type: "cdpEvent",
        tabId: 1,
        method: "Runtime.executionContextCreated",
        params: { context },
      });
    const requireTab = async (_tabId: number, epoch: object) => {
      const admission = methods.get(epoch)!;
      if (admission.method === "Page.getFrameTree" && ++admission.checks === 2) {
        frameTreeHeld.resolve();
        await releaseFrameTree.promise;
      }
      return {
        id: 1,
        url: "https://example.com/fixture",
        windowId: 1,
        groupId: 1,
        incognito: false,
      };
    };
    vi.stubGlobal("chrome", {
      debugger: {
        sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
          switch (method) {
            case "Page.getFrameTree":
              return {
                frameTree: {
                  frame: {
                    id: "fixture-target",
                    loaderId: "loader",
                    url: "https://example.com/fixture",
                  },
                },
              };
            case "Target.getTargetInfo":
              return { targetInfo: { targetId: "fixture-target", title: "Fixture" } };
            case "Runtime.enable":
              event({ id: 1, name: "", auxData: { frameId: "fixture-target", isDefault: true } });
              return {};
            case "Runtime.runIfWaitingForDebugger":
              laterCommand.resolve();
              return {};
            case "Page.createIsolatedWorld":
              event({
                id: 2,
                name: params.worldName,
                auxData: { frameId: "fixture-target", isDefault: false },
              });
              return { executionContextId: 2 };
            case "Runtime.evaluate": {
              objects.set("utility", vm.runInContext(String(params.expression), realm));
              return { result: { type: "object", objectId: "utility" } };
            }
            case "Runtime.callFunctionOn": {
              const args = (params.arguments as Array<{ value?: unknown; objectId?: string }>).map(
                (arg) => (arg.objectId ? objects.get(arg.objectId) : arg.value),
              );
              const fn = vm.runInContext(`(${String(params.functionDeclaration)})`, realm);
              const value = await fn.apply(objects.get(String(params.objectId)), args);
              evaluated.push(value);
              return { result: { type: "object", value } };
            }
            default:
              return {};
          }
        },
      },
    });
    const handler = createRelayCommandHandler({
      send: (message) => send(message),
      isCurrent: () => true,
      attachDebugger: async () => ({ targetId: "fixture-target", assertCurrent: () => {} }),
      detachDebugger: async () => {},
      createTab: async () => {},
      focusWindowForTab: async () => {},
      scheduleTabsSync: () => {},
      captureDebugger: () => () => {},
      captureAccess: (_tabId, method) => {
        const epoch = { revision: 1, groupRevision: 0, tabRevision: 1 };
        methods.set(epoch, { method, checks: 0 });
        return epoch;
      },
      requireAccessibleTab: requireTab,
      requireNavigatedTab: requireTab,
      navigateTab: async () => {},
    });
    await withConnectedDaemon(
      async () => {
        await startBrowserControlServiceFromConfig();
        const ctx = createBrowserControlContext();
        expect(ctx.state().extensionRelays?.get("chrome")?.ownership).toBe(ownership);
        const profile = ctx.forProfile("chrome");
        const listing = profile.listTabs();
        await frameTreeHeld.promise;
        // Unrelated bootstrap commands must progress while frame-tree publication waits.
        await laterCommand.promise;
        releaseFrameTree.resolve();
        await expect(listing).resolves.toEqual([
          expect.objectContaining({ targetId: "fixture-target" }),
        ]);
        const abort = new AbortController();
        const evaluation = executeActViaPlaywright({
          cdpUrl: profile.profile.cdpUrl,
          targetId: "fixture-target",
          action: { kind: "evaluate", fn: "() => 42" },
          evaluateEnabled: true,
          signal: abort.signal,
        });
        void evaluation.catch(() => {});
        try {
          await expect.poll(() => evaluated, { timeout: 1_000 }).toEqual([42]);
          await expect(evaluation).resolves.toMatchObject({ result: 42 });
        } finally {
          abort.abort(new Error("test finished"));
          await evaluation.catch(() => {});
        }
      },
      ownership === "owned"
        ? async () => {
            await startBrowserControlServiceFromConfig();
            const stopped = createDeferred<void>();
            return {
              stop: () => {
                void stopBrowserControlService().then(stopped.resolve, stopped.reject);
              },
              done: stopped.promise,
            };
          }
        : undefined,
      (command, reply) => {
        send = reply;
        void handler(command);
      },
    );
  },
);
