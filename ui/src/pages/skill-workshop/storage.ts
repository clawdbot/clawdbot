import type { SkillWorkshopMode } from "../../lib/skill-workshop/index.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";

const SKILL_WORKSHOP_MODE_KEY = "openclaw:control-ui:skill-workshop-mode:v1";

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
