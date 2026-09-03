export function rejectTelegramNativeButtonParams(params: Record<string, unknown>): void {
  if (params.buttons === undefined) {
    return;
  }
  throw new Error(
    'Telegram native "buttons" is unsupported. Use presentation: {"blocks":[{"type":"buttons","buttons":[{"label":"Yes","action":{"type":"callback","value":"yes"}}]}]}.',
  );
}
