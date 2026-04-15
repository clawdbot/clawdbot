import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import type { PendingApproval, TlonSettingsStore } from "../settings.js";
import { normalizeShip } from "../targets.js";
import { sendDm } from "../urbit/send.js";
import type { UrbitSSEClient } from "../urbit/sse-client.js";
import {
  findPendingApproval,
  formatApprovalConfirmation,
  formatApprovalRequest,
  formatBlockedList,
  formatPendingList,
  parseAdminCommand,
  parseApprovalResponse,
  removePendingApproval,
} from "./approval.js";

type TlonApprovalApi = Pick<UrbitSSEClient, "poke" | "scry">;

type ApprovedMessageProcessor = (approval: PendingApproval) => Promise<void>;

export function createTlonApprovalRuntime(params: {
  api: TlonApprovalApi;
  runtime: RuntimeEnv;
  botShipName: string;
  getPendingApprovals: () => PendingApproval[];
  setPendingApprovals: (approvals: PendingApproval[]) => void;
  getCurrentSettings: () => TlonSettingsStore;
  setCurrentSettings: (settings: TlonSettingsStore) => void;
  getEffectiveDmAllowlist: () => string[];
  setEffectiveDmAllowlist: (ships: string[]) => void;
  getEffectiveOwnerShip: () => string | null;
  processApprovedMessage: ApprovedMessageProcessor;
  refreshWatchedChannels: () => Promise<number>;
}) {
  const {
    api,
    runtime,
    botShipName,
    getPendingApprovals,
    setPendingApprovals,
    getCurrentSettings,
    setCurrentSettings,
    getEffectiveDmAllowlist,
    setEffectiveDmAllowlist,
    getEffectiveOwnerShip,
    processApprovedMessage,
    refreshWatchedChannels,
  } = params;

  const savePendingApprovals = async (): Promise<void> => {
    try {
      await api.poke({
        app: "settings",
        mark: "settings-event",
        json: {
          "put-entry": {
            desk: "moltbot",
            "bucket-key": "tlon",
            "entry-key": "pendingApprovals",
            value: JSON.stringify(getPendingApprovals()),
          },
        },
      });
    } catch (err) {
      runtime.error?.(`[tlon] Failed to save pending approvals: ${String(err)}`);
    }
  };

  const addToDmAllowlist = async (ship: string): Promise<void> => {
    const normalizedShip = normalizeShip(ship);
    const nextAllowlist = getEffectiveDmAllowlist().includes(normalizedShip)
      ? getEffectiveDmAllowlist()
      : [...getEffectiveDmAllowlist(), normalizedShip];
    setEffectiveDmAllowlist(nextAllowlist);
    try {
      await api.poke({
        app: "settings",
        mark: "settings-event",
        json: {
          "put-entry": {
            desk: "moltbot",
            "bucket-key": "tlon",
            "entry-key": "dmAllowlist",
            value: nextAllowlist,
          },
        },
      });
      runtime.log?.(`[tlon] Added ${normalizedShip} to dmAllowlist`);
    } catch (err) {
      runtime.error?.(`[tlon] Failed to update dmAllowlist: ${String(err)}`);
    }
  };

  const addToChannelAllowlist = async (ship: string, channelNest: string): Promise<void> => {
    const normalizedShip = normalizeShip(ship);
    const currentSettings = getCurrentSettings();
    const channelRules = currentSettings.channelRules ?? {};
    const rule = channelRules[channelNest] ?? { mode: "restricted", allowedShips: [] };
    const allowedShips = [...(rule.allowedShips ?? [])];

    if (!allowedShips.includes(normalizedShip)) {
      allowedShips.push(normalizedShip);
    }

    const updatedRules = {
      ...channelRules,
      [channelNest]: { ...rule, allowedShips },
    };
    setCurrentSettings({ ...currentSettings, channelRules: updatedRules });

    try {
      await api.poke({
        app: "settings",
        mark: "settings-event",
        json: {
          "put-entry": {
            desk: "moltbot",
            "bucket-key": "tlon",
            "entry-key": "channelRules",
            value: JSON.stringify(updatedRules),
          },
        },
      });
      runtime.log?.(`[tlon] Added ${normalizedShip} to ${channelNest} allowlist`);
    } catch (err) {
      runtime.error?.(`[tlon] Failed to update channelRules: ${String(err)}`);
    }
  };

  const blockShip = async (ship: string): Promise<void> => {
    const normalizedShip = normalizeShip(ship);
    try {
      await api.poke({
        app: "chat",
        mark: "chat-block-ship",
        json: { ship: normalizedShip },
      });
      runtime.log?.(`[tlon] Blocked ship ${normalizedShip}`);
    } catch (err) {
      runtime.error?.(`[tlon] Failed to block ship ${normalizedShip}: ${String(err)}`);
    }
  };

  const isShipBlocked = async (ship: string): Promise<boolean> => {
    const normalizedShip = normalizeShip(ship);
    try {
      const blocked = (await api.scry("/chat/blocked.json")) as string[] | undefined;
      return (
        Array.isArray(blocked) && blocked.some((item) => normalizeShip(item) === normalizedShip)
      );
    } catch (err) {
      runtime.log?.(`[tlon] Failed to check blocked list: ${String(err)}`);
      return false;
    }
  };

  const getBlockedShips = async (): Promise<string[]> => {
    try {
      const blocked = (await api.scry("/chat/blocked.json")) as string[] | undefined;
      return Array.isArray(blocked) ? blocked : [];
    } catch (err) {
      runtime.log?.(`[tlon] Failed to get blocked list: ${String(err)}`);
      return [];
    }
  };

  const unblockShip = async (ship: string): Promise<boolean> => {
    const normalizedShip = normalizeShip(ship);
    try {
      await api.poke({
        app: "chat",
        mark: "chat-unblock-ship",
        json: { ship: normalizedShip },
      });
      runtime.log?.(`[tlon] Unblocked ship ${normalizedShip}`);
      return true;
    } catch (err) {
      runtime.error?.(`[tlon] Failed to unblock ship ${normalizedShip}: ${String(err)}`);
      return false;
    }
  };

  const sendOwnerNotification = async (message: string): Promise<void> => {
    const ownerShip = getEffectiveOwnerShip();
    if (!ownerShip) {
      runtime.log?.("[tlon] No ownerShip configured, cannot send notification");
      return;
    }
    try {
      await sendDm({
        api,
        fromShip: botShipName,
        toShip: ownerShip,
        text: message,
      });
      runtime.log?.(`[tlon] Sent notification to owner ${ownerShip}`);
    } catch (err) {
      runtime.error?.(`[tlon] Failed to send notification to owner: ${String(err)}`);
    }
  };

  const queueApprovalRequest = async (approval: PendingApproval): Promise<void> => {
    if (await isShipBlocked(approval.requestingShip)) {
      runtime.log?.(`[tlon] Ignoring request from blocked ship ${approval.requestingShip}`);
      return;
    }

    const approvals = getPendingApprovals();
    const existingIndex = approvals.findIndex(
      (item) =>
        item.type === approval.type &&
        item.requestingShip === approval.requestingShip &&
        (approval.type !== "channel" || item.channelNest === approval.channelNest) &&
        (approval.type !== "group" || item.groupFlag === approval.groupFlag),
    );

    if (existingIndex !== -1) {
      const existing = approvals[existingIndex];
      if (approval.originalMessage) {
        existing.originalMessage = approval.originalMessage;
        existing.messagePreview = approval.messagePreview;
      }
      runtime.log?.(
        `[tlon] Updated existing approval for ${approval.requestingShip} (${approval.type}) - re-sending notification`,
      );
      await savePendingApprovals();
      await sendOwnerNotification(formatApprovalRequest(existing));
      return;
    }

    setPendingApprovals([...approvals, approval]);
    await savePendingApprovals();
    await sendOwnerNotification(formatApprovalRequest(approval));
    runtime.log?.(
      `[tlon] Queued approval request: ${approval.id} (${approval.type} from ${approval.requestingShip})`,
    );
  };

  const handleApprovalResponse = async (text: string): Promise<boolean> => {
    const parsed = parseApprovalResponse(text);
    if (!parsed) {
      return false;
    }

    const approval = findPendingApproval(getPendingApprovals(), parsed.id);
    if (!approval) {
      await sendOwnerNotification(
        `No pending approval found${parsed.id ? ` for ID: ${parsed.id}` : ""}`,
      );
      return true;
    }

    if (parsed.action === "approve") {
      switch (approval.type) {
        case "dm":
          await addToDmAllowlist(approval.requestingShip);
          if (approval.originalMessage) {
            runtime.log?.(
              `[tlon] Processing original message from ${approval.requestingShip} after approval`,
            );
            await processApprovedMessage(approval);
          }
          break;
        case "channel":
          if (approval.channelNest) {
            await addToChannelAllowlist(approval.requestingShip, approval.channelNest);
            if (approval.originalMessage) {
              runtime.log?.(
                `[tlon] Processing original message from ${approval.requestingShip} in ${approval.channelNest} after approval`,
              );
              await processApprovedMessage(approval);
            }
          }
          break;
        case "group":
          if (approval.groupFlag) {
            try {
              await api.poke({
                app: "groups",
                mark: "group-join",
                json: {
                  flag: approval.groupFlag,
                  "join-all": true,
                },
              });
              runtime.log?.(`[tlon] Joined group ${approval.groupFlag} after approval`);
              setTimeout(() => {
                void (async () => {
                  try {
                    const newCount = await refreshWatchedChannels();
                    if (newCount > 0) {
                      runtime.log?.(
                        `[tlon] Discovered ${newCount} new channel(s) after joining group`,
                      );
                    }
                  } catch (err) {
                    runtime.log?.(
                      `[tlon] Channel discovery after group join failed: ${String(err)}`,
                    );
                  }
                })();
              }, 2000);
            } catch (err) {
              runtime.error?.(`[tlon] Failed to join group ${approval.groupFlag}: ${String(err)}`);
            }
          }
          break;
      }

      await sendOwnerNotification(formatApprovalConfirmation(approval, "approve"));
    } else if (parsed.action === "block") {
      await blockShip(approval.requestingShip);
      await sendOwnerNotification(formatApprovalConfirmation(approval, "block"));
    } else {
      await sendOwnerNotification(formatApprovalConfirmation(approval, "deny"));
    }

    setPendingApprovals(removePendingApproval(getPendingApprovals(), approval.id));
    await savePendingApprovals();
    return true;
  };

  const handleAdminCommand = async (text: string): Promise<boolean> => {
    const command = parseAdminCommand(text);
    if (!command) {
      return false;
    }

    switch (command.type) {
      case "blocked": {
        const blockedShips = await getBlockedShips();
        await sendOwnerNotification(formatBlockedList(blockedShips));
        runtime.log?.(`[tlon] Owner requested blocked ships list (${blockedShips.length} ships)`);
        return true;
      }
      case "pending":
        await sendOwnerNotification(formatPendingList(getPendingApprovals()));
        runtime.log?.(
          `[tlon] Owner requested pending approvals list (${getPendingApprovals().length} pending)`,
        );
        return true;
      case "unblock": {
        const shipToUnblock = command.ship;
        if (!(await isShipBlocked(shipToUnblock))) {
          await sendOwnerNotification(`${shipToUnblock} is not blocked.`);
          return true;
        }
        const success = await unblockShip(shipToUnblock);
        await sendOwnerNotification(
          success ? `Unblocked ${shipToUnblock}.` : `Failed to unblock ${shipToUnblock}.`,
        );
        return true;
      }
    }
    throw new Error("Unsupported Tlon admin command");
  };

  return {
    queueApprovalRequest,
    handleApprovalResponse,
    handleAdminCommand,
  };
}
