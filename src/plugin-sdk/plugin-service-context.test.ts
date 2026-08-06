import { describe, expectTypeOf, it } from "vitest";
import type { OpenClawPluginServiceContext as CoreServiceContext } from "./core.js";
import type { DiagnosticEventPrivateData } from "./diagnostic-runtime.js";
import type { OpenClawPluginServiceContext as PluginEntryServiceContext } from "./plugin-entry.js";

type ListenerArgs<T extends { internalDiagnostics?: unknown }> =
  NonNullable<T["internalDiagnostics"]> extends { onEvent: infer TOnEvent }
    ? TOnEvent extends (listener: infer TListener) => unknown
      ? TListener extends (...args: infer TArgs) => unknown
        ? TArgs
        : never
      : never
    : never;

type ListenerPrivateData<T extends { internalDiagnostics?: unknown }> = ListenerArgs<T>[2];

describe("plugin service diagnostics contract", () => {
  it("keeps host attribution out of public SDK listener declarations", () => {
    expectTypeOf<
      ListenerPrivateData<PluginEntryServiceContext>
    >().toEqualTypeOf<DiagnosticEventPrivateData>();
    expectTypeOf<
      ListenerPrivateData<CoreServiceContext>
    >().toEqualTypeOf<DiagnosticEventPrivateData>();
    expectTypeOf<ListenerArgs<PluginEntryServiceContext>["length"]>().toEqualTypeOf<3>();
    expectTypeOf<ListenerArgs<CoreServiceContext>["length"]>().toEqualTypeOf<3>();
    expectTypeOf<
      "hostPluginId" extends keyof ListenerPrivateData<PluginEntryServiceContext> ? true : false
    >().toEqualTypeOf<false>();
  });
});
