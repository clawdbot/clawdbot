/**
 * Tests the registered gateway server method list and exported method names.
 */
import { describe, expect, it } from "vitest";
import {
  createCoreGatewayMethodDescriptors,
  listCoreGatewayMethodNames,
  STARTUP_UNAVAILABLE_GATEWAY_METHODS,
} from "./methods/core-descriptors.js";
import { GATEWAY_AUX_METHODS } from "./server-aux-methods.js";
import { GATEWAY_EVENTS, listGatewayMethods } from "./server-methods-list.js";
import { LEGACY_ADVERTISED_GATEWAY_METHODS } from "./server-methods-list.test-fixtures.js";
import { coreGatewayHandlers } from "./server-methods.js";

describe("GATEWAY_EVENTS", () => {
  it("advertises Talk event streams in hello features", () => {
    expect(GATEWAY_EVENTS).toContain("talk.event");
    expect(GATEWAY_EVENTS).not.toContain("talk.realtime.relay");
    expect(GATEWAY_EVENTS).not.toContain("talk.transcription.relay");
  });

  it("advertises node topology updates", () => {
    expect(GATEWAY_EVENTS).toContain("node.presence");
    expect(GATEWAY_EVENTS).toContain("node.hostStats");
    expect(GATEWAY_EVENTS).toContain("device.pair.setup.completed");
    expect(GATEWAY_EVENTS).toContain("device.pair.changed");
    expect(GATEWAY_EVENTS).toContain("node.runnerInventory.changed");
  });

  it("advertises skill invalidation updates", () => {
    expect(GATEWAY_EVENTS).toContain("skills.changed");
  });

  it("advertises profile-scoped preference invalidation updates", () => {
    expect(GATEWAY_EVENTS).toContain("users.prefs.changed");
  });

  it("advertises portal replace-set updates", () => {
    expect(GATEWAY_EVENTS).toContain("portal.changed");
  });

  it("advertises session observer digests", () => {
    expect(GATEWAY_EVENTS).toContain("session.observer");
  });

  it("advertises question methods and events", () => {
    expect(GATEWAY_EVENTS).toContain("question.requested");
    expect(GATEWAY_EVENTS).toContain("question.resolved");
    expect(listGatewayMethods()).toEqual(
      expect.arrayContaining([
        "question.request",
        "question.waitAnswer",
        "question.resolve",
        "question.get",
        "question.list",
      ]),
    );
  });
});

describe("listGatewayMethods", () => {
  it("advertises plugin surface refresh for capability rotation", () => {
    expect(listGatewayMethods()).toContain("plugin.surface.refresh");
    expect(listGatewayMethods()).toContain("node.pluginSurface.refresh");
  });

  it("advertises node plugin tool catalog updates", () => {
    expect(listGatewayMethods()).toContain("node.pluginTools.update");
  });

  it("advertises node skill catalog updates", () => {
    expect(listGatewayMethods()).toContain("node.skills.update");
  });

  it("advertises unified approval lookup, history, and resolution", () => {
    expect(listGatewayMethods()).toContain("approval.get");
    expect(listGatewayMethods()).toContain("approval.history");
    expect(listGatewayMethods()).toContain("approval.resolve");
  });

  it("appends plugin UI methods without changing the complete legacy method prefix", () => {
    const methods = listGatewayMethods();
    const legacyCount = LEGACY_ADVERTISED_GATEWAY_METHODS.length;

    expect(methods.slice(0, legacyCount)).toEqual(LEGACY_ADVERTISED_GATEWAY_METHODS);
    expect(methods.slice(legacyCount, legacyCount + 4)).toEqual([
      "plugins.controlUi.list",
      "plugins.controlUi.reload",
      "plugins.controlUi.report",
      "plugins.controlUi.status",
    ]);
  });

  it("advertises ClawHub skill trust methods", () => {
    const methods = listGatewayMethods();
    expect(methods).toContain("skills.securityVerdicts");
    expect(methods).toContain("skills.skillCard");
  });

  it("advertises Control UI GitHub previews", () => {
    expect(listGatewayMethods()).toContain("controlUi.githubPreview");
  });

  it("advertises Control UI session pull request detection", () => {
    expect(listGatewayMethods()).toContain("controlUi.sessionPullRequests.subscribe");
    expect(GATEWAY_EVENTS).toContain("controlUi.sessionPullRequests.changed");
  });

  it("advertises explicit session viewer presence", () => {
    expect(listGatewayMethods()).toContain("sessions.viewers.set");
  });

  it("advertises session workspace reveal", () => {
    expect(listGatewayMethods()).toContain("sessions.files.reveal");
    expect(coreGatewayHandlers["sessions.files.reveal"]).toBeTypeOf("function");
  });

  it("advertises the versioned activity audit method", () => {
    expect(listGatewayMethods()).toContain("audit.activity.list");
    expect(coreGatewayHandlers["audit.activity.list"]).toBeTypeOf("function");
    expect(listGatewayMethods()).toContain("audit.run.inspect");
    expect(coreGatewayHandlers["audit.run.inspect"]).toBeTypeOf("function");
  });

  it.each(["update.hold", "update.runs.get", "update.runs.list"])("advertises %s", (method) => {
    expect(listGatewayMethods()).toContain(method);
    expect(coreGatewayHandlers[method]).toBeTypeOf("function");
  });

  it("keeps deprecated restart preflight compatibility read-only and advertised", () => {
    const methods = listGatewayMethods();
    const descriptor = createCoreGatewayMethodDescriptors(coreGatewayHandlers).find(
      (candidate) => candidate.name === "gateway.restart.preflight",
    );

    expect(methods).toContain("gateway.restart.preflight");
    expect(methods.indexOf("gateway.restart.preflight")).toBe(
      methods.indexOf("gateway.restart.request") - 1,
    );
    expect(coreGatewayHandlers["gateway.restart.preflight"]).toBeTypeOf("function");
    expect(descriptor).toMatchObject({
      name: "gateway.restart.preflight",
      scope: "operator.read",
      since: "<=2026.7",
    });
    expect(descriptor?.controlPlaneWrite).toBeUndefined();
  });

  it("classifies cron mutations as control-plane writes", () => {
    const descriptors = createCoreGatewayMethodDescriptors(coreGatewayHandlers);

    for (const method of ["cron.add", "cron.update", "cron.remove", "cron.run"]) {
      expect(descriptors.find((descriptor) => descriptor.name === method)).toMatchObject({
        name: method,
        scope: "operator.admin",
        controlPlaneWrite: true,
      });
    }
    for (const method of ["cron.get", "cron.list", "cron.status", "cron.runs"]) {
      expect(
        descriptors.find((descriptor) => descriptor.name === method)?.controlPlaneWrite,
      ).toBeUndefined();
    }
  });

  it("does not advertise hidden core handlers", () => {
    const methods = listGatewayMethods();
    expect(methods).not.toContain("node.runnerInventory.update");
    expect(methods).not.toContain("config.openFile");
    expect(methods).not.toContain("chat.inject");
    expect(methods).not.toContain("nativeHook.invoke");
    expect(methods).not.toContain("sessions.usage");
  });

  it("rate-limits speculative inference under operator write authority", () => {
    const descriptors = createCoreGatewayMethodDescriptors(coreGatewayHandlers);
    expect(
      descriptors.find((descriptor) => descriptor.name === "sessions.title.prepare"),
    ).toMatchObject({
      scope: "operator.write",
      controlPlaneWrite: true,
    });
  });

  it("registers the hidden node protocol feature publication method", () => {
    const descriptor = createCoreGatewayMethodDescriptors(coreGatewayHandlers).find(
      (candidate) => candidate.name === "node.runnerInventory.update",
    );

    expect(coreGatewayHandlers["node.runnerInventory.update"]).toBeTypeOf("function");
    expect(descriptor).toMatchObject({
      name: "node.runnerInventory.update",
      scope: "node",
      advertise: false,
    });
  });

  it("advertises the versioned Talk session RPCs", () => {
    const methods = listGatewayMethods();
    expect(methods).toContain("talk.client.create");
    expect(methods).toContain("talk.client.transcript");
    expect(methods).toContain("talk.client.close");
    expect(methods).toContain("talk.client.toolCall");
    expect(methods).toContain("talk.client.steer");
    expect(methods).toContain("talk.session.create");
    expect(methods).toContain("talk.session.appendAudio");
    expect(methods).toContain("talk.session.cancelOutput");
    expect(methods).toContain("talk.session.acknowledgeMark");
    expect(methods).toContain("talk.session.submitToolResult");
    expect(methods).toContain("talk.session.steer");
    expect(methods).toContain("talk.session.close");
  });

  it("advertises and wires cloud worker environment mutations", () => {
    const methods = ["environments.create", "environments.destroy"] as const;
    const advertisedMethods = listGatewayMethods();
    const descriptors = createCoreGatewayMethodDescriptors(coreGatewayHandlers);

    for (const method of methods) {
      expect(advertisedMethods).toContain(method);
      expect(coreGatewayHandlers[method]).toEqual(expect.any(Function));
      expect(STARTUP_UNAVAILABLE_GATEWAY_METHODS).toContain(method);
      expect(descriptors.find((descriptor) => descriptor.name === method)).toMatchObject({
        name: method,
        scope: "operator.admin",
        startup: "unavailable-until-sidecars",
        controlPlaneWrite: true,
      });
    }
  });

  it("advertises placement mutations with target-aware scopes", () => {
    const advertisedMethods = listGatewayMethods();
    const descriptors = createCoreGatewayMethodDescriptors(coreGatewayHandlers);
    const scopes = new Map([
      ["sessions.dispatch", "dynamic"],
      ["sessions.move", "dynamic"],
      ["sessions.reclaim", "operator.write"],
    ]);

    for (const [method, scope] of scopes) {
      expect(advertisedMethods).toContain(method);
      expect(coreGatewayHandlers[method]).toEqual(expect.any(Function));
      expect(STARTUP_UNAVAILABLE_GATEWAY_METHODS).toContain(method);
      expect(descriptors.find((descriptor) => descriptor.name === method)).toMatchObject({
        name: method,
        scope,
        startup: "unavailable-until-sidecars",
        controlPlaneWrite: true,
      });
    }
  });

  it("classifies proposal evaluation as a control-plane write", () => {
    const descriptors = createCoreGatewayMethodDescriptors(coreGatewayHandlers);

    expect(
      descriptors.find((descriptor) => descriptor.name === "skills.proposals.evaluate"),
    ).toMatchObject({
      scope: "operator.admin",
      controlPlaneWrite: true,
    });
  });

  it("classifies project cloning as a described control-plane write", () => {
    const descriptors = createCoreGatewayMethodDescriptors(coreGatewayHandlers);

    expect(descriptors.find((descriptor) => descriptor.name === "projects.add")).toMatchObject({
      scope: "operator.write",
      controlPlaneWrite: true,
    });
    expect(
      descriptors.find((descriptor) => descriptor.name === "projects.searchRemote"),
    ).toMatchObject({
      scope: "operator.read",
      description: "Search GitHub repositories that can be cloned as managed projects.",
    });
  });

  it("wires a dispatchable handler for every core descriptor", () => {
    // A descriptor without a matching entry in the lazy handler routing table
    // advertises a method that then dispatches as "unknown method" — exactly
    // how terminal.attach/list/text and later sessions.dispatch first shipped
    // broken. Aux methods are injected at server construction; assistant media
    // is served by the control-ui handler.
    const injectedElsewhere = new Set<string>([...GATEWAY_AUX_METHODS, "assistant.media.get"]);
    const missing = listCoreGatewayMethodNames()
      .filter((method) => !injectedElsewhere.has(method))
      .filter((method) => typeof coreGatewayHandlers[method] !== "function");
    expect(missing).toEqual([]);
  });
});
