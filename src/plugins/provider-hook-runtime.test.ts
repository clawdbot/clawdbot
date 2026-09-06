import { expect, it, vi } from "vitest";
import { getModelProviderLocalServiceReconciler } from "../agents/provider-local-service-reconcile.js";
import { attachModelProviderRuntimePluginHandle } from "./provider-hook-runtime.js";

it("clears a stale local-service reconciler when the prepared provider changes", () => {
  const reconcile = vi.fn(async () => undefined);
  const withReconciler = attachModelProviderRuntimePluginHandle(
    { id: "demo", provider: "local", baseUrl: "http://127.0.0.1:1/v1" },
    { plugin: { reconcileLocalService: reconcile } } as never,
  );
  const withoutReconciler = attachModelProviderRuntimePluginHandle(withReconciler, {
    plugin: {},
  } as never);

  expect(getModelProviderLocalServiceReconciler(withReconciler)).toBe(reconcile);
  expect(getModelProviderLocalServiceReconciler(withoutReconciler)).toBeUndefined();
});
