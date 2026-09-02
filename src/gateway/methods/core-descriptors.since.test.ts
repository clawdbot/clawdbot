import { describe, expect, it } from "vitest";
import { listCoreGatewayMethodMetadata } from "./core-descriptors.js";

const TRAIN_2026_7_METHODS = [
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
  "audit.run.inspect",
  "board.widget.appView",
  "tts.speak",
  "environments.list",
  "environments.status",
  "environments.create",
  "environments.destroy",
  "sessions.dispatch",
  "sessions.reclaim",
  "sessions.viewers.set",
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
  "sessions.observer.visibility",
  "sessions.companion.ask",
  "sessions.companion.state",
  "sessions.companion.reset",
  "channels.pairing.list",
  "channels.pairing.approve",
  "channels.pairing.dismiss",
  "controlUi.sessionPullRequests.subscribe",
  "cron.scratch.get",
  "cron.scratch.set",
  "memory.search",
  "skills.proposals.evaluate",
  "skills.proposals.events.list",
  "hooks.status",
  "tasks.retry",
  "tasks.dismiss",
] as const;

const CURRENT_TRAIN_METHODS = [
  "diagnostics.lanes",
  "plugins.inspect",
  "device.pair.setupStatus",
  "openclaw.setup.activate.start",
  "exec.approval.grants.list",
  "exec.approval.grants.revoke",
  "sessions.patchMany",
  "sessions.goal.update",
  "sessions.goal.clear",
  "sessions.groups.update",
  "sessions.groups.defaults",
  "sessions.recover",
  "update.hold",
  "sessions.catalog.startTerminal",
  "sessions.github.publish",
  "sessions.github.options",
  "sessions.github.status",
  "sessions.github.confirm",
  "users.github.status",
  "users.github.authorize.start",
  "users.github.authorize.poll",
  "users.github.authorize.cancel",
  "users.github.disconnect",
  "worker.desktop.observe",
  "projects.list",
  "projects.register",
  "projects.remove",
  "projects.add",
  "projects.searchRemote",
  "worker.desktop.launch",
  "secrets.store.list",
  "secrets.store.set",
  "secrets.store.delete",
  "users.prefs.get",
  "users.prefs.set",
  "push.web.preferences.get",
  "push.web.preferences.set",
  "users.setRole",
  "desktop.observe",
  "desktop.launch",
  "device.scopes.requestUpgrade",
  "device.scopes.waitUpgrade",
  "node.runnerInventory.update",
  "portal.list",
  "portal.open",
  "portal.close",
  "sessions.move",
  "sessions.assignOwner",
  "controlUi.sessionPreview",
  "progressCard.get",
  "progressCard.put",
  "tools.github.status",
  "tools.github.configure",
  "tools.github.authorize.start",
  "tools.github.authorize.poll",
  "tools.github.authorize.cancel",
  "session.members.listEvidence",
  "skills.library.list",
  "skills.library.read",
  "skills.library.save",
  "skills.library.mutate",
  "skills.library.activate",
  "skills.library.import",
  "skills.library.upload",
] as const;

describe("core gateway method release trains", () => {
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
    ).toEqual(TRAIN_2026_7_METHODS.toSorted());
    expect(
      methods
        .filter((method) => method.since === "2026.8")
        .map((method) => method.name)
        .toSorted(),
    ).toEqual(CURRENT_TRAIN_METHODS.toSorted());
    expect(methods.find((method) => method.name === "update.hold")?.since).toBe("2026.8");
    expect(methods.find((method) => method.name === "sessions.catalog.startTerminal")?.since).toBe(
      "2026.8",
    );
    expect(methods.find((method) => method.name === "worker.desktop.observe")?.since).toBe(
      "2026.8",
    );
    for (const method of [
      "projects.list",
      "projects.register",
      "projects.remove",
      "projects.add",
      "projects.searchRemote",
    ]) {
      expect(methods.find((candidate) => candidate.name === method)?.since).toBe("2026.8");
    }
    expect(methods.find((method) => method.name === "worker.desktop.launch")?.since).toBe("2026.8");
  });
});
