import { getSafeLocalStorage } from "../local-storage.ts";
import {
  BOOT_RECORD_MAX_BYTES,
  BOOT_RECORD_PREFIX,
  bootRecordGeneration,
  type BootRecord,
} from "./boot-record.ts";

let timer: ReturnType<typeof setTimeout> | undefined;

export function scheduleBootRecord(record: BootRecord): void {
  clearTimeout(timer);
  const generation = bootRecordGeneration;
  timer = setTimeout(() => {
    if (generation !== bootRecordGeneration) {
      return;
    }
    const storage = getSafeLocalStorage();
    const key = BOOT_RECORD_PREFIX + record.scope;
    try {
      const agents = {
        ...record.agents,
        agents: record.agents.agents.map((agent) => {
          const identity = agent.identity ? { ...agent.identity } : undefined;
          if (identity) {
            delete identity.avatar;
            delete identity.avatarUrl;
          }
          return { ...agent, identity };
        }),
      };
      const json = JSON.stringify({ ...record, agents });
      if (new TextEncoder().encode(json).length > BOOT_RECORD_MAX_BYTES) {
        storage?.removeItem(key);
      } else {
        storage?.setItem(key, json);
      }
    } catch {
      try {
        storage?.removeItem(key);
      } catch {}
    }
  }, 500);
}
