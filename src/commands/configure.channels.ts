import { getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import type { ClawdbotConfig } from "../config/config.js";
import { CONFIG_PATH_CLAWDBOT } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { confirm, select } from "./configure.shared.js";
import { guardCancel } from "./onboard-helpers.js";

export async function removeChannelConfigWizard(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
): Promise<ClawdbotConfig> {
  let next = { ...cfg };

  const listConfiguredChannels = () =>
    listChannelPlugins()
      .map((plugin) => plugin.meta)
      .filter((meta) => next.channels?.[meta.id] !== undefined);

  while (true) {
    const configured = listConfiguredChannels();
    if (configured.length === 0) {
      note(
        [
          "No channel config found in clawdbot.json.",
          "Tip: `clawdbot channels status` shows what is configured and enabled.",
        ].join("\n"),
        "Remove channel",
      );
      return next;
    }

    const channel = guardCancel(
      await select({
        message: "Remove which channel config?",
        options: [
          ...configured.map((meta) => ({
            value: meta.id,
            label: meta.label,
            hint: "Deletes tokens + settings from config (credentials stay on disk)",
          })),
          { value: "done", label: "Done" },
        ],
      }),
      runtime,
    ) as string;

    if (channel === "done") return next;

    const label = getChannelPlugin(channel)?.meta.label ?? channel;
    const confirmed = guardCancel(
      await confirm({
        message: `Delete ${label} configuration from ${CONFIG_PATH_CLAWDBOT}?`,
        initialValue: false,
      }),
      runtime,
    );
    if (!confirmed) continue;

    const nextChannels: Record<string, unknown> = { ...next.channels };
    delete nextChannels[channel];
    next = {
      ...next,
      channels: Object.keys(nextChannels).length
        ? (nextChannels as ClawdbotConfig["channels"])
        : undefined,
    };

    note(
      [`${label} removed from config.`, "Note: credentials/sessions on disk are unchanged."].join(
        "\n",
      ),
      "Channel removed",
    );
  }
}
