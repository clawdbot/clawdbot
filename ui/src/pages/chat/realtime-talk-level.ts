type RealtimeTalkLevelListener = (level: number) => void;

export class RealtimeTalkLevelSignal {
  private listeners = new Set<RealtimeTalkLevelListener>();
  private currentLevel = 0;

  get value(): number {
    return this.currentLevel;
  }

  set(rawLevel: number): void {
    const boundedLevel = Number.isFinite(rawLevel) ? Math.min(1, Math.max(0, rawLevel)) : 0;
    const level = Math.round(boundedLevel * 100) / 100;
    if (level === this.currentLevel) {
      return;
    }
    this.currentLevel = level;
    for (const listener of this.listeners) {
      listener(level);
    }
  }

  subscribe(listener: RealtimeTalkLevelListener): () => void {
    this.listeners.add(listener);
    listener(this.currentLevel);
    return () => this.listeners.delete(listener);
  }
}
