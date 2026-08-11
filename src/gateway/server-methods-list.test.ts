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

  it("advertises skill invalidation updates", () => {
    expect(GATEWAY_EVENTS).toContain("skills.changed");
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

  it("appends new methods after model probing without shifting older method indices", () => {
    expect(listGatewayMethods().slice(-39)).toEqual([
      "models.probe",
      "migrations.memory.plan",
      "migrations.memory.apply",
      "ui.command",
      "approval.history",
      "plugin.surface.refresh",
      "conversations.list",
      "session.discussion.info",
      "session.discussion.open",
      "board.prompt.authorize",
      "board.data.read",
      "board.action",
      "sessions.observer.visibility",
      "session.visibility.set",
      "session.members.list",
      "session.members.add",
      "session.members.remove",
      "session.suggestions.add",
      "session.suggestions.list",
      "session.suggestions.resolve",
      "session.typing",
      "sessions.companion.ask",
      "sessions.companion.state",
      "sessions.companion.reset",
      "memory.search",
      "skills.proposals.events.list",
      "skills.proposals.evaluate",
      "hooks.status",
      "tasks.retry",
      "tasks.dismiss",
      "audit.run.inspect",
      "sessions.patchMany",
      "update.hold",
      "sessions.catalog.startTerminal",
      "worker.desktop.observe",
      "projects.list",
      "projects.register",
      "projects.remove",
      "worker.desktop.launch",
    ]);
    const methods = listGatewayMethods();
    expect(methods.indexOf("node.pluginSurface.refresh")).toBe(
      methods.indexOf("node.describe") + 1,
    );
    expect(methods.indexOf("node.pluginTools.update")).toBe(
      methods.indexOf("node.pluginSurface.refresh") + 1,
    );
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

  it("advertises the update campaign hold method", () => {
    expect(listGatewayMethods()).toContain("update.hold");
    expect(coreGatewayHandlers["update.hold"]).toBeTypeOf("function");
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
    expect(methods.slice(31, 36)).toEqual([
      "exec.approvals.get",
      "exec.approvals.set",
      "exec.approvals.node.get",
      "exec.approvals.node.set",
      "exec.approval.get",
    ]);
    expect(methods).toContain("tts.speak");
    expect(coreMethods.slice(-46)).toEqual([
      "sessions.catalog.continue",
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
      "approval.history",
      "plugin.surface.refresh",
      "conversations.list",
      "session.discussion.info",
      "session.discussion.open",
      "board.prompt.authorize",
      "board.data.read",
      "board.action",
      "sessions.observer.visibility",
      "session.visibility.set",
      "session.members.list",
      "session.members.add",
      "session.members.remove",
      "session.suggestions.add",
      "session.suggestions.list",
      "session.suggestions.resolve",
      "session.typing",
      "sessions.companion.ask",
      "sessions.companion.state",
      "sessions.companion.reset",
      "memory.search",
      "skills.proposals.events.list",
      "skills.proposals.evaluate",
      "hooks.status",
      "tasks.retry",
      "tasks.dismiss",
      "audit.run.inspect",
      "sessions.patchMany",
      "update.hold",
      "sessions.catalog.startTerminal",
      "worker.desktop.observe",
      "projects.list",
      "projects.register",
      "projects.remove",
      "worker.desktop.launch",
    ]);
    expect(methods.indexOf("approval.get")).toBeGreaterThan(methods.indexOf("tts.speak"));
    expect(methods.indexOf("approval.resolve")).toBe(methods.indexOf("approval.get") + 1);
    expect(methods.indexOf("audit.run.inspect")).toBe(methods.indexOf("tasks.dismiss") + 1);
    expect(methods.indexOf("sessions.patchMany")).toBe(methods.indexOf("audit.run.inspect") + 1);
    expect(methods.indexOf("update.hold")).toBe(methods.indexOf("sessions.patchMany") + 1);
    expect(methods.indexOf("sessions.catalog.startTerminal")).toBe(
      methods.indexOf("update.hold") + 1,
    );
    expect(methods.indexOf("worker.desktop.observe")).toBe(
      methods.indexOf("sessions.catalog.startTerminal") + 1,
    );
    expect(methods.indexOf("projects.list")).toBe(methods.indexOf("worker.desktop.observe") + 1);
    expect(methods.indexOf("projects.register")).toBe(methods.indexOf("projects.list") + 1);
    expect(methods.indexOf("projects.remove")).toBe(methods.indexOf("projects.register") + 1);
    expect(methods.indexOf("worker.desktop.launch")).toBe(methods.indexOf("projects.remove") + 1);
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

  it("classifies proposal evaluation as a control-plane write", () => {
    const descriptors = createCoreGatewayMethodDescriptors(coreGatewayHandlers);

    expect(
      descriptors.find((descriptor) => descriptor.name === "skills.proposals.evaluate"),
    ).toMatchObject({
      scope: "operator.admin",
      controlPlaneWrite: true,
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
