// Private MIME keeps stray text and file drags from becoming session actions.
export const SESSION_DRAG_MIME = "application/x-openclaw-session-key";
const SESSION_GROUP_DRAG_MIME = "application/x-openclaw-session-group";
const SIDEBAR_ROUTE_DRAG_MIME = "application/x-openclaw-sidebar-route";

export function writeSessionDragData(dataTransfer: DataTransfer, sessionKey: string): void {
  dataTransfer.setData(SESSION_DRAG_MIME, sessionKey);
  dataTransfer.setData("text/plain", sessionKey);
  // Sidebar sessions can move between groups or copy into a chat split pane.
  dataTransfer.effectAllowed = "copyMove";
}

export function readSessionDragData(dataTransfer: DataTransfer | null): string | null {
  const sessionKey = dataTransfer?.getData(SESSION_DRAG_MIME).trim();
  return sessionKey || null;
}

export function sessionDragActive(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.types ?? []).includes(SESSION_DRAG_MIME);
}

export function writeSessionGroupDragData(dataTransfer: DataTransfer, group: string): void {
  dataTransfer.setData(SESSION_GROUP_DRAG_MIME, group);
  dataTransfer.effectAllowed = "move";
}

export function readSessionGroupDragData(dataTransfer: DataTransfer | null): string | null {
  const group = dataTransfer?.getData(SESSION_GROUP_DRAG_MIME).trim();
  return group || null;
}

export function sessionGroupDragActive(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.types ?? []).includes(SESSION_GROUP_DRAG_MIME);
}

export function writeSidebarRouteDragData(dataTransfer: DataTransfer, route: string): void {
  dataTransfer.setData(SIDEBAR_ROUTE_DRAG_MIME, route);
  dataTransfer.effectAllowed = "move";
}

export function readSidebarRouteDragData(dataTransfer: DataTransfer | null): string | null {
  const route = dataTransfer?.getData(SIDEBAR_ROUTE_DRAG_MIME).trim();
  return route || null;
}

export function sidebarRouteDragActive(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.types ?? []).includes(SIDEBAR_ROUTE_DRAG_MIME);
}
