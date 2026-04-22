let _embeddedMode = false;

export function setEmbeddedMode(value: boolean): void {
  _embeddedMode = value;
}

export function isEmbeddedMode(): boolean {
  return _embeddedMode;
}
