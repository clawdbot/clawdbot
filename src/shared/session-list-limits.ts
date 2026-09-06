/** Owner-first rosters retain this window independently of shared-page pagination. */
export const SESSIONS_LIST_OWNER_LIMIT = 60;

/** Rows the Control UI sidebar roster requests in one page. Sized so a normal
 *  install holds every session; beyond it the list's Load more control fetches
 *  the next page, so a category whose newest session falls outside this window
 *  is reachable rather than silently empty. Tune here. */
export const SIDEBAR_SESSION_ROSTER_LIMIT = 200;
