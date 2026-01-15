import { parseList } from "../format";
import type { ConnectionsState } from "./connections.types";

export async function saveSignalConfig(state: ConnectionsState) {
  if (!state.client || !state.connected) return;
  if (state.signalSaving) return;
  state.signalSaving = true;
  state.signalConfigStatus = null;
  try {
    const baseHash = state.configSnapshot?.hash;
    if (!baseHash) {
      state.signalConfigStatus = "Config hash missing; reload and retry.";
      return;
    }
    const signal: Record<string, unknown> = {};
    const form = state.signalForm;

    if (form.enabled) {
      signal.enabled = null;
    } else {
      signal.enabled = false;
    }

    const account = form.account.trim();
    signal.account = account || null;

    const httpUrl = form.httpUrl.trim();
    signal.httpUrl = httpUrl || null;

    const httpHost = form.httpHost.trim();
    signal.httpHost = httpHost || null;

    const httpPort = Number(form.httpPort);
    if (Number.isFinite(httpPort) && httpPort > 0) {
      signal.httpPort = httpPort;
    } else {
      signal.httpPort = null;
    }

    const cliPath = form.cliPath.trim();
    signal.cliPath = cliPath || null;

    if (form.autoStart) {
      signal.autoStart = null;
    } else {
      signal.autoStart = false;
    }

    if (form.receiveMode === "on-start" || form.receiveMode === "manual") {
      signal.receiveMode = form.receiveMode;
    } else {
      signal.receiveMode = null;
    }

    signal.ignoreAttachments = form.ignoreAttachments ? true : null;
    signal.ignoreStories = form.ignoreStories ? true : null;
    signal.sendReadReceipts = form.sendReadReceipts ? true : null;

    const allowFrom = parseList(form.allowFrom);
    signal.allowFrom = allowFrom.length > 0 ? allowFrom : null;

    const mediaMaxMb = Number(form.mediaMaxMb);
    if (Number.isFinite(mediaMaxMb) && mediaMaxMb > 0) {
      signal.mediaMaxMb = mediaMaxMb;
    } else {
      signal.mediaMaxMb = null;
    }

    const raw = `${JSON.stringify(
      { channels: { signal } },
      null,
      2,
    ).trimEnd()}\n`;
    await state.client.request("config.patch", { raw, baseHash });
    state.signalConfigStatus = "Saved. Restart gateway if needed.";
  } catch (err) {
    state.signalConfigStatus = String(err);
  } finally {
    state.signalSaving = false;
  }
}
