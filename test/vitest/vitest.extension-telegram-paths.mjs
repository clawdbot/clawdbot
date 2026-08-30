// Test routing roots for Telegram extension tests.
export const telegramExtensionTestRoots = ["extensions/telegram"];

export function isTelegramExtensionRoot(root) {
  return telegramExtensionTestRoots.includes(root);
}
