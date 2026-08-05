import type { ApplicationSkillWorkshopRevisionHandoff } from "./context.ts";

export function createSkillWorkshopRevisionHandoff(): ApplicationSkillWorkshopRevisionHandoff {
  let pending: Parameters<ApplicationSkillWorkshopRevisionHandoff["prepare"]>[0] | null = null;
  return {
    prepare: (handoff) => {
      pending = handoff;
    },
    consume: (sessionKey, owner) => {
      if (!pending || pending.sessionKey !== sessionKey || pending.owner !== owner) {
        return null;
      }
      const handoff = pending;
      pending = null;
      return handoff;
    },
    clear: (handoff) => {
      if (!handoff || pending === handoff) {
        pending = null;
      }
    },
  };
}
