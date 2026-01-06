import { note } from "@clack/prompts";

import {
  enableSystemdUserLinger,
  readSystemdUserLingerStatus,
} from "../daemon/systemd.js";
import type { RuntimeEnv } from "../runtime.js";

export type LingerPrompter = {
  confirm?: (params: {
    message: string;
    initialValue?: boolean;
  }) => Promise<boolean>;
  note: (message: string, title?: string) => Promise<void> | void;
};

export async function ensureSystemdUserLingerInteractive(params: {
  runtime: RuntimeEnv;
  prompter?: LingerPrompter;
  env?: NodeJS.ProcessEnv;
  title?: string;
  reason?: string;
  prompt?: boolean;
  requireConfirm?: boolean;
}): Promise<void> {
  if (process.platform !== "linux") return;
  if (params.prompt === false) return;
  const env = params.env ?? process.env;
  const prompter = params.prompter ?? { note };
  const title = params.title ?? "Systemd";
  const status = await readSystemdUserLingerStatus(env);
  if (!status) {
    await prompter.note(
      "Unable to read loginctl linger status. Ensure systemd + loginctl are available.",
      title,
    );
    return;
  }
  if (status.linger === "yes") return;

  const reason =
    params.reason ??
    "Systemd user services stop when you log out or go idle, which kills the Gateway.";
  const actionNote = params.requireConfirm
    ? "We can enable lingering now (may require sudo; writes /var/lib/systemd/linger)."
    : "Enabling lingering now (may require sudo; writes /var/lib/systemd/linger).";
  await prompter.note(`${reason}\n${actionNote}`, title);

  if (params.requireConfirm && prompter.confirm) {
    const ok = await prompter.confirm({
      message: `Enable systemd lingering for ${status.user}?`,
      initialValue: true,
    });
    if (!ok) {
      await prompter.note(
        "Without lingering, the Gateway will stop when you log out.",
        title,
      );
      return;
    }
  }

  const resultNoSudo = await enableSystemdUserLinger({
    env,
    user: status.user,
  });
  if (resultNoSudo.ok) {
    await prompter.note(`Enabled systemd lingering for ${status.user}.`, title);
    return;
  }

  const result = await enableSystemdUserLinger({
    env,
    user: status.user,
    sudoMode: "prompt",
  });
  if (result.ok) {
    await prompter.note(`Enabled systemd lingering for ${status.user}.`, title);
    return;
  }

  params.runtime.error(
    `Failed to enable lingering: ${result.stderr || result.stdout || "unknown error"}`,
  );
  await prompter.note(
    `Run manually: sudo loginctl enable-linger ${status.user}`,
    title,
  );
}

export async function ensureSystemdUserLingerNonInteractive(params: {
  runtime: RuntimeEnv;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (process.platform !== "linux") return;
  const env = params.env ?? process.env;
  const status = await readSystemdUserLingerStatus(env);
  if (!status || status.linger === "yes") return;

  const result = await enableSystemdUserLinger({
    env,
    user: status.user,
    sudoMode: "non-interactive",
  });
  if (result.ok) {
    params.runtime.log(`Enabled systemd lingering for ${status.user}.`);
    return;
  }

  params.runtime.log(
    `Systemd lingering is disabled for ${status.user}. Run: sudo loginctl enable-linger ${status.user}`,
  );
}
