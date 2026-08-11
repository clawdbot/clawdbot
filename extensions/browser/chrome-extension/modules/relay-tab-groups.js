import { OPENCLAW_TAB_GROUP_TITLE } from "./relay-core.js";

export async function findOpenClawGroups() {
  try {
    return await chrome.tabGroups.query({ title: OPENCLAW_TAB_GROUP_TITLE });
  } catch {
    return [];
  }
}

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
