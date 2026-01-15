import { parseList } from "../format";
import type { ConnectionsState } from "./connections.types";

export async function saveIMessageConfig(state: ConnectionsState) {
  if (!state.client || !state.connected) return;
  if (state.imessageSaving) return;
  state.imessageSaving = true;
  state.imessageConfigStatus = null;
  try {
    const baseHash = state.configSnapshot?.hash;
    if (!baseHash) {
      state.imessageConfigStatus = "Config hash missing; reload and retry.";
      return;
    }
    const imessage: Record<string, unknown> = {};
    const form = state.imessageForm;

    if (form.enabled) {
      imessage.enabled = null;
    } else {
      imessage.enabled = false;
    }

    const cliPath = form.cliPath.trim();
    imessage.cliPath = cliPath || null;

    const dbPath = form.dbPath.trim();
    imessage.dbPath = dbPath || null;

    if (form.service === "auto") {
      imessage.service = null;
    } else {
      imessage.service = form.service;
    }

    const region = form.region.trim();
    imessage.region = region || null;

    const allowFrom = parseList(form.allowFrom);
    imessage.allowFrom = allowFrom.length > 0 ? allowFrom : null;

    imessage.includeAttachments = form.includeAttachments ? true : null;

    const mediaMaxMb = Number(form.mediaMaxMb);
    if (Number.isFinite(mediaMaxMb) && mediaMaxMb > 0) {
      imessage.mediaMaxMb = mediaMaxMb;
    } else {
      imessage.mediaMaxMb = null;
    }

    const raw = `${JSON.stringify(
      { channels: { imessage } },
      null,
      2,
    ).trimEnd()}\n`;
    await state.client.request("config.patch", { raw, baseHash });
    state.imessageConfigStatus = "Saved. Restart gateway if needed.";
  } catch (err) {
    state.imessageConfigStatus = String(err);
  } finally {
    state.imessageSaving = false;
  }
}
