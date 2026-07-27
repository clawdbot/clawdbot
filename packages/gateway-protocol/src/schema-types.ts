/**
 * Type-only schema barrel for the package root.
 *
 * Keep this module list aligned with `schema.ts`, except for the runtime-only
 * `protocol-schemas` registry. Routing root type exports through that registry
 * retains the full registry in downstream declaration bundles.
 */
export type * from "./schema/primitives.js";
export type * from "./schema/agent.js";
export type * from "./schema/agents-models-skills.js";
export type * from "./schema/agents-workspace.js";
export type * from "./schema/artifacts.js";
export type * from "./schema/approvals.js";
export type * from "./schema/audit-activity.js";
export type * from "./schema/audit.js";
export type * from "./schema/board.js";
export type * from "./schema/users.js";
export type * from "./schema/channels.js";
export type * from "./schema/channel-pairing.js";
export type * from "./schema/talk-marks.js";
export type * from "./schema/commands.js";
export type * from "./schema/config.js";
export type * from "./schema/openclaw.js";
export type * from "./schema/cron.js";
export type * from "./schema/cron.types.js";
export type * from "./schema/error-codes.js";
export type * from "./schema/environments.js";
export type * from "./schema/exec-approvals.js";
export type * from "./schema/devices.js";
export type * from "./schema/frames.js";
export type * from "./schema/fs.js";
export type * from "./schema/gateway-suspend.js";
export type * from "./schema/logs-chat.js";
export type * from "./schema/migrations.js";
export type * from "./schema/nodes.js";
export type * from "./schema/push.js";
export type * from "./schema/questions.js";
export type * from "./schema/secrets.js";
export type * from "./schema/session-placement.js";
export type * from "./schema/session-discussion.js";
export type * from "./schema/sessions.js";
export type * from "./schema/sessions-sharing.js";
export type * from "./schema/sessions-suggestions.js";
export type * from "./schema/sessions-catalog.js";
export type * from "./schema/skill-history.js";
export type * from "./schema/snapshot.js";
export type * from "./schema/system-info.js";
export type * from "./schema/system-event.js";
export type * from "./schema/task-suggestions.js";
export type * from "./schema/tasks.js";
export type * from "./schema/terminal.js";
export type * from "./schema/ui-command.js";
export type * from "./schema/plugin-approvals.js";
export type * from "./schema/plugins.js";
export type * from "./schema/wizard.js";
export type * from "./schema/worker-admission.js";
export type * from "./schema/worker-inference.js";
export type * from "./schema/worktrees.js";
