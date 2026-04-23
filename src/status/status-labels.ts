export const formatFastModeLabel = (enabled: boolean): string | null => {
  if (!enabled) {
    return null;
  }
  return "Fast";
};
