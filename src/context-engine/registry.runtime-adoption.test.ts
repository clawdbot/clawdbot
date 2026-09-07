// Caller-owned handles adopt root runtime context engines without full plugin setup.
import { describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { adoptRuntimeContextEngineRegistrations, type ContextEngineFactory } from "./registry.js";

const unusedFactory: ContextEngineFactory = async () => {
  throw new Error("context engine factory should not run");
};

function registryWithPluginEngine(params: {
  pluginId: string;
  engineId: string;
  lifecycle: "runtime" | "readOnlyDiscovery";
  source?: string;
  status?: "loaded" | "disabled" | "error";
  owner?: string;
  factory?: ContextEngineFactory;
}) {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(
    createPluginRecord({
      id: params.pluginId,
      source: params.source ?? `/tmp/${params.pluginId}`,
      status: params.status ?? "loaded",
    }),
  );
  registry.contextEngines.set(params.engineId, {
    factory: params.factory ?? unusedFactory,
    owner: params.owner ?? `plugin:${params.pluginId}`,
    lifecycle: params.lifecycle,
  });
  return registry;
}

describe("adoptRuntimeContextEngineRegistrations", () => {
  it("copies a missing full-mode runtime engine from the composition-root registry", () => {
    const runtimeFactory: ContextEngineFactory = async () => {
      throw new Error("runtime factory should not run");
    };
    const root = registryWithPluginEngine({
      pluginId: "ce-probe",
      engineId: "ce-probe",
      lifecycle: "runtime",
      factory: runtimeFactory,
    });
    const scoped = createEmptyPluginRegistry();
    scoped.plugins.push(createPluginRecord({ id: "ce-probe", source: "/tmp/ce-probe" }));

    const adopted = adoptRuntimeContextEngineRegistrations(scoped, root);

    expect(adopted).not.toBe(scoped);
    expect(scoped.contextEngines.get("ce-probe")).toBeUndefined();
    expect(adopted.contextEngines.get("ce-probe")).toEqual({
      factory: runtimeFactory,
      owner: "plugin:ce-probe",
      lifecycle: "runtime",
    });
  });

  it("upgrades a matching read-only discovery entry to the root runtime factory", () => {
    const discoveryFactory: ContextEngineFactory = async () => {
      throw new Error("discovery factory should not run");
    };
    const runtimeFactory: ContextEngineFactory = async () => {
      throw new Error("runtime factory should not run");
    };
    const scoped = registryWithPluginEngine({
      pluginId: "ce-probe",
      engineId: "ce-probe",
      lifecycle: "readOnlyDiscovery",
      factory: discoveryFactory,
    });
    const root = registryWithPluginEngine({
      pluginId: "ce-probe",
      engineId: "ce-probe",
      lifecycle: "runtime",
      factory: runtimeFactory,
    });

    const adopted = adoptRuntimeContextEngineRegistrations(scoped, root);

    expect(scoped.contextEngines.get("ce-probe")?.factory).toBe(discoveryFactory);
    expect(adopted.contextEngines.get("ce-probe")?.factory).toBe(runtimeFactory);
    expect(adopted.contextEngines.get("ce-probe")?.lifecycle).toBe("runtime");
  });

  it("returns the original handle when nothing can be adopted", () => {
    const scoped = createEmptyPluginRegistry();
    const root = createEmptyPluginRegistry();

    expect(adoptRuntimeContextEngineRegistrations(scoped, root)).toBe(scoped);
  });

  it("does not copy engines from a different plugin source", () => {
    const root = registryWithPluginEngine({
      pluginId: "ce-probe",
      engineId: "ce-probe",
      lifecycle: "runtime",
      source: "/tmp/root-ce-probe",
    });
    const scoped = createEmptyPluginRegistry();
    scoped.plugins.push(createPluginRecord({ id: "ce-probe", source: "/tmp/shadow-ce-probe" }));

    expect(adoptRuntimeContextEngineRegistrations(scoped, root)).toBe(scoped);
  });

  it("does not copy engines whose plugin is absent from the caller-owned handle", () => {
    const root = registryWithPluginEngine({
      pluginId: "ce-probe",
      engineId: "ce-probe",
      lifecycle: "runtime",
    });
    const scoped = createEmptyPluginRegistry();

    expect(adoptRuntimeContextEngineRegistrations(scoped, root)).toBe(scoped);
  });

  it("does not replace an existing runtime registration", () => {
    const scopedFactory: ContextEngineFactory = async () => {
      throw new Error("scoped factory should not run");
    };
    const rootFactory: ContextEngineFactory = async () => {
      throw new Error("root factory should not run");
    };
    const scoped = registryWithPluginEngine({
      pluginId: "ce-probe",
      engineId: "ce-probe",
      lifecycle: "runtime",
      factory: scopedFactory,
    });
    const root = registryWithPluginEngine({
      pluginId: "ce-probe",
      engineId: "ce-probe",
      lifecycle: "runtime",
      factory: rootFactory,
    });

    const adopted = adoptRuntimeContextEngineRegistrations(scoped, root);

    expect(adopted).toBe(scoped);
    expect(adopted.contextEngines.get("ce-probe")?.factory).toBe(scopedFactory);
  });

  it("does not copy core-owned engines or disabled plugin engines", () => {
    const root = createEmptyPluginRegistry();
    root.contextEngines.set("legacy", {
      factory: unusedFactory,
      owner: "core",
      lifecycle: "runtime",
    });
    root.plugins.push(
      createPluginRecord({ id: "ce-probe", source: "/tmp/ce-probe", status: "loaded" }),
    );
    root.contextEngines.set("ce-probe", {
      factory: unusedFactory,
      owner: "plugin:ce-probe",
      lifecycle: "runtime",
    });
    const scoped = createEmptyPluginRegistry();
    scoped.plugins.push(
      createPluginRecord({ id: "ce-probe", source: "/tmp/ce-probe", status: "disabled" }),
    );

    expect(adoptRuntimeContextEngineRegistrations(scoped, root)).toBe(scoped);
  });
});
