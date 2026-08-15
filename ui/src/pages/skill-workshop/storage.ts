import type { SkillWorkshopMode } from "../../lib/skill-workshop/index.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";

const SKILL_WORKSHOP_MODE_KEY = "openclaw:control-ui:skill-workshop-mode:v1";
const SKILL_WORKSHOP_CURRENT_CHAT_REVISIONS_KEY =
  "openclaw:control-ui:skill-workshop-current-chat-revisions:v1";

export function loadSkillWorkshopMode(): SkillWorkshopMode {
  try {
    return getSafeLocalStorage()?.getItem(SKILL_WORKSHOP_MODE_KEY) === "board" ? "board" : "today";
  } catch {
    return "today";
  }
}

export function saveSkillWorkshopMode(mode: SkillWorkshopMode): void {
  try {
    getSafeLocalStorage()?.setItem(SKILL_WORKSHOP_MODE_KEY, mode);
  } catch {
    // best-effort
  }
}

export function loadSkillWorkshopUseCurrentChatForRevisions(): boolean {
  try {
    return getSafeLocalStorage()?.getItem(SKILL_WORKSHOP_CURRENT_CHAT_REVISIONS_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveSkillWorkshopUseCurrentChatForRevisions(enabled: boolean): void {
  try {
    getSafeLocalStorage()?.setItem(SKILL_WORKSHOP_CURRENT_CHAT_REVISIONS_KEY, String(enabled));
  } catch {
    // best-effort
  }
}
