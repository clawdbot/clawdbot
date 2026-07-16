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
import { coreGatewayHandlers } from "./server-methods.js";

describe("GATEWAY_EVENTS", () => {
  it("advertises Talk event streams in hello features", () => {
    expect(GATEWAY_EVENTS).toContain("talk.event");
    expect(GATEWAY_EVENTS).not.toContain("talk.realtime.relay");
    expect(GATEWAY_EVENTS).not.toContain("talk.transcription.relay");
  });

  it("advertises node presence activity updates", () => {
    expect(GATEWAY_EVENTS).toContain("node.presence");
  });
});

describe("listGatewayMethods", () => {
  it("advertises plugin surface refresh for capability rotation", () => {
    expect(listGatewayMethods()).toContain("node.pluginSurface.refresh");
  });

  it("advertises node plugin tool catalog updates", () => {
    expect(listGatewayMethods()).toContain("node.pluginTools.update");
  });

  it("advertises node skill catalog updates", () => {
    expect(listGatewayMethods()).toContain("node.skills.update");
  });

  it("advertises unified approval lookup and resolution", () => {
    expect(listGatewayMethods()).toContain("approval.get");
    expect(listGatewayMethods()).toContain("approval.resolve");
  });

  it("appends memory migration after model probing without shifting older method indices", () => {
    expect(listGatewayMethods().slice(-4)).toEqual([
      "models.probe",
      "migrations.memory.plan",
      "migrations.memory.apply",
      "ui.command",
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
    expect(listGatewayMethods()).toContain("controlUi.sessionPullRequests");
  });

  it("advertises the versioned activity audit method", () => {
    expect(listGatewayMethods()).toContain("audit.activity.list");
    expect(coreGatewayHandlers["audit.activity.list"]).toBeTypeOf("function");
  });

  it("does not advertise hidden core handlers", () => {
    const methods = listGatewayMethods();
    expect(methods).not.toContain("config.openFile");
    expect(methods).not.toContain("chat.inject");
    expect(methods).not.toContain("nativeHook.invoke");
    expect(methods).not.toContain("sessions.usage");
  });

  it("preserves the legacy advertised method order", () => {
    const methods = listGatewayMethods();
    const coreMethods = listCoreGatewayMethodNames();
    expect(methods.slice(0, 5)).toEqual([
      "health",
      "diagnostics.stability",
      "doctor.memory.status",
      "doctor.memory.dreamDiary",
      "doctor.memory.backfillDreamDiary",
    ]);
    expect(methods.slice(32, 37)).toEqual([
      "exec.approvals.get",
      "exec.approvals.set",
      "exec.approvals.node.get",
      "exec.approvals.node.set",
      "exec.approval.get",
    ]);
    expect(methods).toContain("tts.speak");
    expect(coreMethods.slice(-10)).toEqual([
      "sessions.catalog.archive",
      "approval.get",
      "approval.resolve",
      "sessions.search",
      "sessions.dispatch",
      "sessions.reclaim",
      "models.probe",
      "migrations.memory.plan",
      "migrations.memory.apply",
      "ui.command",
    ]);
    expect(methods.indexOf("approval.get")).toBeGreaterThan(methods.indexOf("tts.speak"));
    expect(methods.indexOf("approval.resolve")).toBe(methods.indexOf("approval.get") + 1);
  });

  it("advertises the versioned Talk session RPCs", () => {
    const methods = listGatewayMethods();
    expect(methods).toContain("talk.client.create");
    expect(methods).toContain("talk.client.toolCall");
    expect(methods).toContain("talk.client.steer");
    expect(methods).toContain("talk.session.create");
    expect(methods).toContain("talk.session.join");
    expect(methods).toContain("talk.session.appendAudio");
    expect(methods).toContain("talk.session.startTurn");
    expect(methods).toContain("talk.session.endTurn");
    expect(methods).toContain("talk.session.cancelTurn");
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
