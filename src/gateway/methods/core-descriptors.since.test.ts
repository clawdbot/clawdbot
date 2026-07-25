import { describe, expect, it } from "vitest";
import { listCoreGatewayMethodMetadata, listCoreGatewayMethodNames } from "./core-descriptors.js";

const CURRENT_TRAIN_METHODS = [
  "question.request",
  "question.waitAnswer",
  "question.resolve",
  "question.get",
  "question.list",
  "session.discussion.info",
  "session.discussion.open",
  "session.members.add",
  "session.members.list",
  "session.members.remove",
  "session.suggestions.add",
  "session.suggestions.list",
  "session.suggestions.resolve",
  "session.typing",
  "session.visibility.set",
  "board.prompt.authorize",
  "board.data.read",
  "board.action",
  "terminal.open",
  "terminal.input",
  "terminal.resize",
  "terminal.close",
  "terminal.attach",
  "terminal.list",
  "terminal.text",
  "terminal.upload",
  "worktrees.list",
  "worktrees.branches",
  "worktrees.create",
  "worktrees.remove",
  "worktrees.restore",
  "worktrees.gc",
  "agents.workspace.list",
  "agents.workspace.get",
  "audit.list",
  "audit.activity.list",
  "board.widget.appView",
  "tts.speak",
  "environments.list",
  "environments.status",
  "environments.create",
  "environments.destroy",
  "sessions.dispatch",
  "sessions.reclaim",
  "sessions.catalog.list",
  "sessions.catalog.read",
  "sessions.catalog.continue",
  "sessions.catalog.archive",
  "approval.get",
  "approval.resolve",
  "approval.history",
  "migrations.memory.plan",
  "openclaw.chat.history",
  "migrations.memory.apply",
  "gateway.suspend.prepare",
  "gateway.suspend.status",
  "gateway.suspend.resume",
  "ui.command",
  "device.pair.rename",
  "sessions.observer.ask",
  "sessions.observer.visibility",
  "subagents.allowLease.acquire",
  "subagents.allowLease.status",
  "subagents.allowLease.release",
  "sessions_spawn",
  "sessions_list",
  "sessions_status",
  "sessions_history",
  "sessions.companion.ask",
  "sessions.companion.state",
  "sessions.companion.reset",
  "channels.pairing.list",
  "channels.pairing.approve",
  "channels.pairing.dismiss",
  "cron.scratch.get",
  "cron.scratch.set",
] as const;

describe("core gateway method release trains", () => {
  it("keeps external orchestrator aliases out of generated native protocol enums", () => {
    const coreMethods = listCoreGatewayMethodNames();
    const nativeMethods = listCoreGatewayMethodMetadata()
      .filter((method) => method.nativeProtocol !== false)
      .map((method) => method.name);
    const externalAliases = [
      "subagents.allowLease.acquire",
      "subagents.allowLease.status",
      "subagents.allowLease.release",
      "sessions_spawn",
      "sessions_list",
      "sessions_status",
      "sessions_history",
    ];

    for (const method of externalAliases) {
      expect(coreMethods).toContain(method);
      expect(nativeMethods).not.toContain(method);
    }
    expect(nativeMethods).toContain("sessions.list");
  });

  it("keeps allow-lease acquisition behind the admin-scoped spawn gate", () => {
    const byName = new Map(listCoreGatewayMethodMetadata().map((method) => [method.name, method]));

    expect(byName.get("subagents.allowLease.acquire")).toMatchObject({
      scope: "operator.admin",
      nativeProtocol: false,
    });
    expect(byName.get("sessions_spawn")).toMatchObject({
      scope: "operator.write",
      nativeProtocol: false,
    });
    expect(byName.get("subagents.allowLease.status")).toMatchObject({
      scope: "operator.read",
      nativeProtocol: false,
    });
  });

  it("appends Agentic OS runtime aliases and companion methods after the existing core protocol table", () => {
    const methods = listCoreGatewayMethodMetadata().map((method) => method.name);
    expect(methods.slice(-10)).toEqual([
      "subagents.allowLease.acquire",
      "subagents.allowLease.status",
      "subagents.allowLease.release",
      "sessions_spawn",
      "sessions_list",
      "sessions_status",
      "sessions_history",
      "sessions.companion.ask",
      "sessions.companion.state",
      "sessions.companion.reset",
    ]);
  });

  it("records a valid train for every method and dates the 2026.7 families", () => {
    const methods = listCoreGatewayMethodMetadata();

    for (const method of methods) {
      expect(method.since, method.name).toMatch(/^(<=)?\d{4}\.\d{1,2}$/);
    }

    expect(
      methods
        .filter((method) => method.since === "2026.7")
        .map((method) => method.name)
        .toSorted(),
    ).toEqual(CURRENT_TRAIN_METHODS.toSorted());
  });
});
