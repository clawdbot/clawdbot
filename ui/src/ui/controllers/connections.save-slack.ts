import { parseList } from "../format";
import { defaultSlackActions, type SlackActionForm } from "../ui-types";
import type { ConnectionsState } from "./connections.types";

export async function saveSlackConfig(state: ConnectionsState) {
  if (!state.client || !state.connected) return;
  if (state.slackSaving) return;
  state.slackSaving = true;
  state.slackConfigStatus = null;
  try {
    const baseHash = state.configSnapshot?.hash;
    if (!baseHash) {
      state.slackConfigStatus = "Config hash missing; reload and retry.";
      return;
    }
    const slack: Record<string, unknown> = {};
    const form = state.slackForm;

    if (form.enabled) {
      slack.enabled = null;
    } else {
      slack.enabled = false;
    }

    if (!state.slackTokenLocked) {
      const token = form.botToken.trim();
      slack.botToken = token || null;
    }
    if (!state.slackAppTokenLocked) {
      const token = form.appToken.trim();
      slack.appToken = token || null;
    }

    const dm: Record<string, unknown> = {};
    dm.enabled = form.dmEnabled;
    const allowFrom = parseList(form.allowFrom);
    dm.allowFrom = allowFrom.length > 0 ? allowFrom : null;
    if (form.groupEnabled) {
      dm.groupEnabled = true;
    } else {
      dm.groupEnabled = null;
    }
    const groupChannels = parseList(form.groupChannels);
    dm.groupChannels = groupChannels.length > 0 ? groupChannels : null;
    slack.dm = dm;

    const mediaMaxMb = Number.parseFloat(form.mediaMaxMb);
    if (Number.isFinite(mediaMaxMb) && mediaMaxMb > 0) {
      slack.mediaMaxMb = mediaMaxMb;
    } else {
      slack.mediaMaxMb = null;
    }

    const textChunkLimit = Number.parseInt(form.textChunkLimit, 10);
    if (Number.isFinite(textChunkLimit) && textChunkLimit > 0) {
      slack.textChunkLimit = textChunkLimit;
    } else {
      slack.textChunkLimit = null;
    }

    if (form.reactionNotifications === "own") {
      slack.reactionNotifications = null;
    } else {
      slack.reactionNotifications = form.reactionNotifications;
    }
    const reactionAllowlist = parseList(form.reactionAllowlist);
    if (reactionAllowlist.length > 0) {
      slack.reactionAllowlist = reactionAllowlist;
    } else {
      slack.reactionAllowlist = null;
    }

    const slash: Record<string, unknown> = {};
    if (form.slashEnabled) {
      slash.enabled = true;
    } else {
      slash.enabled = null;
    }
    if (form.slashName.trim()) slash.name = form.slashName.trim();
    else slash.name = null;
    if (form.slashSessionPrefix.trim())
      slash.sessionPrefix = form.slashSessionPrefix.trim();
    else slash.sessionPrefix = null;
    if (form.slashEphemeral) {
      slash.ephemeral = null;
    } else {
      slash.ephemeral = false;
    }
    slack.slashCommand = slash;

    const actions: Partial<SlackActionForm> = {};
    const applyAction = (key: keyof SlackActionForm) => {
      const value = form.actions[key];
      if (value !== defaultSlackActions[key]) actions[key] = value;
    };
    applyAction("reactions");
    applyAction("messages");
    applyAction("pins");
    applyAction("memberInfo");
    applyAction("emojiList");
    if (Object.keys(actions).length > 0) {
      slack.actions = actions;
    } else {
      slack.actions = null;
    }

    const channels = form.channels
      .map((entry): [string, Record<string, unknown>] | null => {
        const key = entry.key.trim();
        if (!key) return null;
        const record: Record<string, unknown> = {
          allow: entry.allow,
          requireMention: entry.requireMention,
        };
        return [key, record];
      })
      .filter((value): value is [string, Record<string, unknown>] =>
        Boolean(value),
      );
    if (channels.length > 0) {
      slack.channels = Object.fromEntries(channels);
    } else {
      slack.channels = null;
    }

    const raw = `${JSON.stringify(
      { channels: { slack } },
      null,
      2,
    ).trimEnd()}\n`;
    await state.client.request("config.patch", { raw, baseHash });
    state.slackConfigStatus = "Saved. Restart gateway if needed.";
  } catch (err) {
    state.slackConfigStatus = String(err);
  } finally {
    state.slackSaving = false;
  }
}
