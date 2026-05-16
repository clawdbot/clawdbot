import { describe, expect, it } from "vitest";
import { GATEWAY_EVENTS, listGatewayMethods } from "./server-methods-list.js";

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

  it("does not advertise hidden core handlers", () => {
    const methods = listGatewayMethods();
    expect(methods).not.toContain("config.openFile");
    expect(methods).not.toContain("chat.inject");
    expect(methods).not.toContain("nativeHook.invoke");
    expect(methods).not.toContain("sessions.usage");
  });

  it("preserves the legacy advertised method order", () => {
    const methods = listGatewayMethods();
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
  });

  it("advertises the versioned Talk session RPCs", () => {
    const methods = listGatewayMethods();
    expect(methods).toContain("talk.client.create");
    expect(methods).toContain("talk.client.toolCall");
    expect(methods).toContain("talk.session.create");
    expect(methods).toContain("talk.session.join");
    expect(methods).toContain("talk.session.appendAudio");
    expect(methods).toContain("talk.session.startTurn");
    expect(methods).toContain("talk.session.endTurn");
    expect(methods).toContain("talk.session.cancelTurn");
    expect(methods).toContain("talk.session.cancelOutput");
    expect(methods).toContain("talk.session.submitToolResult");
    expect(methods).toContain("talk.session.close");
  });
});
