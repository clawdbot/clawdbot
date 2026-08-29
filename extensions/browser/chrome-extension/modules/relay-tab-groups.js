import { OPENCLAW_TAB_GROUP_TITLE } from "./relay-core.js";

async function isOpenClawGroupId(groupId) {
  if (!Number.isInteger(groupId) || groupId < 0) {
    return false;
  }
  try {
    const group = await chrome.tabGroups.get(groupId);
    return group.title === OPENCLAW_TAB_GROUP_TITLE;
  } catch {
    return false;
  }
}

export async function isTabSelected(tab) {
  return await isOpenClawGroupId(tab?.groupId);
}
