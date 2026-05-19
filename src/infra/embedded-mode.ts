let embeddedModeValue = false;

export function setEmbeddedMode(value: boolean): void {
  embeddedModeValue = value;
}

export function isEmbeddedMode(): boolean {
  return embeddedModeValue;
}
