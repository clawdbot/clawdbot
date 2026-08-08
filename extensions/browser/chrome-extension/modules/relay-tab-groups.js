import { OPENCLAW_TAB_GROUP_TITLE } from "./relay-core.js";

export async function findOpenClawGroups() {
  try {
    return await chrome.tabGroups.query({ title: OPENCLAW_TAB_GROUP_TITLE });
  } catch {
    return [];
  }
}

export async function listSharedTabs() {
  const groups = await findOpenClawGroups();
  const tabs = [];
  for (const group of groups) {
    const groupTabs = await chrome.tabs.query({ groupId: group.id });
    tabs.push(...groupTabs);
  }
  return tabs.filter((tab) => typeof tab.id === "number");
}

export async function isOpenClawGroupId(groupId) {
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

export async function requireSharedTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!(await isOpenClawGroupId(tab.groupId))) {
    throw new Error(`tab ${tabId} is not in the ${OPENCLAW_TAB_GROUP_TITLE} tab group`);
  }
  return tab;
}
