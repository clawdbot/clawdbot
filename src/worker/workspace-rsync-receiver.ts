import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { compileFunction } from "node:vm";
import { REMOTE_WORKSPACE_ACCEPTED_RSYNC_RECEIVER_JS } from "../gateway/worker-environments/workspace-accepted-remote-script.js";
import { REMOTE_WORKSPACE_RSYNC_RECEIVER_JS } from "../gateway/worker-environments/workspace-mutation-remote-script.js";

const FIXED_DESTINATION = "openclaw-rsync-destination";
const [mode, encodedContext, nonce, ...receiverArgs] = process.argv.slice(2);
if (
  !/^(?:workspace-root|git-pack|accepted-next)$/u.test(mode ?? "") ||
  !/^[A-Za-z0-9_-]+$/u.test(encodedContext ?? "") ||
  !/^[a-f0-9]{32}$/u.test(nonce ?? "") ||
  receiverArgs.at(-1) !== FIXED_DESTINATION
) {
  throw new Error("invalid worker workspace rsync receiver invocation");
}
const contextBytes = Buffer.from(encodedContext!, "base64url");
const context: unknown = JSON.parse(contextBytes.toString("utf8"));
if (
  contextBytes.toString("base64url") !== encodedContext ||
  !Array.isArray(context) ||
  context.length !== 3 ||
  !context.every((value) => typeof value === "string")
) {
  throw new Error("invalid worker workspace rsync receiver context");
}
const [workspace, canonicalHome, remoteRelative] = context as [string, string, string];
const receiverMode = mode!;
const receiverNonce = nonce!;

const receiverTarget =
  receiverMode === "git-pack"
    ? path.posix.join(workspace, ".openclaw-base.pack")
    : receiverMode === "accepted-next"
      ? path.posix.join(
          path.posix.dirname(workspace),
          `.openclaw-accepted-${createHash("sha256").update(workspace).digest("hex")}-${receiverNonce}`,
          "next",
        )
      : workspace;
// rsync implementations disagree on quote preservation in --rsync-path. This entry accepts only
// safe words, then restores the attested destination before the shared locked receiver runs.
process.argv = [
  process.argv[0]!,
  workspace,
  canonicalHome,
  remoteRelative,
  receiverNonce,
  ...(receiverMode === "accepted-next" ? [] : [receiverTarget]),
  ...receiverArgs.with(receiverArgs.length - 1, receiverTarget),
];
compileFunction(
  receiverMode === "accepted-next"
    ? REMOTE_WORKSPACE_ACCEPTED_RSYNC_RECEIVER_JS
    : REMOTE_WORKSPACE_RSYNC_RECEIVER_JS,
  ["require"],
)(createRequire(import.meta.url));
