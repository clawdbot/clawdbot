// Discord plugin module tracks recent presence baselines for online transitions.
const DEFAULT_PRESENCE_BASELINE_MAX_ENTRIES = 75_000;

export class DiscordPresenceBaselineCache {
  private readonly offlineByKey = new Map<string, string>();
  private readonly onlineByKey = new Map<string, string>();

  constructor(private readonly maxEntries = DEFAULT_PRESENCE_BASELINE_MAX_ENTRIES) {}

  clear(): void {
    this.offlineByKey.clear();
    this.onlineByKey.clear();
  }

  clearScope(scope: string): void {
    for (const markers of [this.offlineByKey, this.onlineByKey]) {
      for (const [key, markerScope] of markers) {
        if (markerScope === scope) {
          markers.delete(key);
        }
      }
    }
  }

  isOffline(scope: string, key: string): boolean {
    return this.offlineByKey.get(key) === scope;
  }

  isOnline(scope: string, key: string): boolean {
    return this.onlineByKey.get(key) === scope;
  }

  observeOffline(scope: string, key: string): string | undefined {
    this.deleteMarker(this.onlineByKey, scope, key);
    return this.observe(this.offlineByKey, scope, key);
  }

  observeOnline(scope: string, key: string): string | undefined {
    this.deleteMarker(this.offlineByKey, scope, key);
    return this.observe(this.onlineByKey, scope, key);
  }

  private deleteMarker(markers: Map<string, string>, scope: string, key: string): void {
    if (markers.get(key) === scope) {
      markers.delete(key);
    }
  }

  private observe(markers: Map<string, string>, scope: string, key: string): string | undefined {
    markers.delete(key);
    markers.set(key, scope);
    let evictedScope: string | undefined;
    while (markers.size > this.maxEntries) {
      const oldestKey = markers.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      evictedScope = markers.get(oldestKey);
      markers.delete(oldestKey);
    }
    return evictedScope;
  }
}
