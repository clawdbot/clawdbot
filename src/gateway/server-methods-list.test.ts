/**
 * Tests the registered gateway server method list and exported method names.
 */
import { describe, expect, it } from "vitest";
import {
  CORE_GATEWAY_METHOD_SPECS,
  createCoreGatewayMethodDescriptors,
  listCoreGatewayMethodNames,
  STARTUP_UNAVAILABLE_GATEWAY_METHODS,
} from "./methods/core-descriptors.js";
import { GATEWAY_EVENTS, listGatewayMethods } from "./server-methods-list.js";
import { coreGatewayHandlers } from "./server-methods.js";

describe("GATEWAY_EVENTS", () => {
  it("advertises Talk event streams in hello features", () => {
    expect(GATEWAY_EVENTS).toContain("talk.event");
    expect(GATEWAY_EVENTS).not.toContain("talk.realtime.relay");
    expect(GATEWAY_EVENTS).not.toContain("talk.transcription.relay");
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

  it("advertises ClawHub skill trust methods", () => {
    const methods = listGatewayMethods();
    expect(methods).toContain("skills.securityVerdicts");
    expect(methods).toContain("skills.skillCard");
  });

  it("advertises Control UI GitHub previews", () => {
    expect(listGatewayMethods()).toContain("controlUi.githubPreview");
  });

  it("advertises Crestodian setup methods with their dispatch policy", () => {
    const methods = listGatewayMethods();
    expect(methods).toContain("crestodian.setup.verify");
    expect(methods).toContain("crestodian.setup.auth.start");
    expect(coreGatewayHandlers["crestodian.setup.verify"]).toEqual(expect.any(Function));
    expect(coreGatewayHandlers["crestodian.setup.auth.start"]).toEqual(expect.any(Function));
    expect(
      CORE_GATEWAY_METHOD_SPECS.find((spec) => spec.name === "crestodian.setup.verify")
        ?.controlPlaneWrite,
    ).toBeUndefined();
    // Candidate activation is an admin-only probe that persists only on
    // success. The generic three-write budget would strand the automatic
    // fallback ladder before its fourth candidate or a manual retry.
    expect(
      CORE_GATEWAY_METHOD_SPECS.find((spec) => spec.name === "crestodian.setup.activate")
        ?.controlPlaneWrite,
    ).toBeUndefined();
    expect(methods.indexOf("crestodian.setup.verify")).toBeGreaterThan(
      methods.indexOf("tts.speak"),
    );
    expect(methods.indexOf("crestodian.setup.auth.start")).toBe(
      methods.indexOf("crestodian.setup.activate") + 1,
    );
    expect(methods.indexOf("wizard.start")).toBe(
      methods.indexOf("crestodian.setup.auth.start") + 1,
    );
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
    expect(coreMethods.slice(-5)).toEqual([
      "sessions.catalog.continue",
      "sessions.catalog.archive",
      "approval.get",
      "approval.resolve",
      "sessions.search",
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

  it("wires a dispatchable handler for every terminal.* descriptor", () => {
    // A descriptor without a matching entry in the lazy handler routing table
    // advertises a method that then dispatches as "unknown method" — exactly
    // how terminal.attach/list/text first shipped broken. (Approval methods
    // are excluded: they are injected per-request via extraHandlers.)
    const missing = listCoreGatewayMethodNames()
      .filter((method) => method.startsWith("terminal."))
      .filter((method) => typeof coreGatewayHandlers[method] !== "function");
    expect(missing).toEqual([]);
  });
});
