// Lazy boundary: keeps the critical-notice module (toast host, i18n strings,
// transition tracker) out of the Control UI startup chunk. Loaded by app-host
// on the first session.observer digest; the tracker singleton lives here so
// recovery transitions stay visible to the dedupe contract across loads.
import {
  CriticalObserverNoticeTracker,
  showCriticalSessionObserverNotice,
} from "./critical-observer-notice.ts";

const tracker = new CriticalObserverNoticeTracker();

type HandleParams = Omit<Parameters<typeof showCriticalSessionObserverNotice>[0], "tracker">;

export function handleCriticalObserverDigest(params: HandleParams): void {
  showCriticalSessionObserverNotice({ ...params, tracker });
}

export function resetCriticalObserverTracker(): void {
  tracker.clear();
}
