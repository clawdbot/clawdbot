let pwAiLoaded = false;

export function markPwAiLoaded(): void {
  pwAiLoaded = true;
}

export function isPwAiLoaded(): boolean {
  return pwAiLoaded;
}
