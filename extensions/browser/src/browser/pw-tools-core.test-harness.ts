import { beforeEach, vi } from "vitest";

let currentPage: Record<string, unknown> | null = null;
let currentRefLocator: Record<string, unknown> | null = null;
let pageState: {
  console: unknown[];
  armIdUpload: number;
  armIdDialog: number;
  armIdDownload: number;
  downloadWaiterDepth: number;
} = {
  console: [],
  armIdUpload: 0,
  armIdDialog: 0,
  armIdDownload: 0,
  downloadWaiterDepth: 0,
};

const sessionMocks = vi.hoisted(() => ({
  assertPageNavigationCompletedSafely: vi.fn(async () => {}),
  getPageForTargetId: vi.fn(async () => {
    if (!currentPage) {
      throw new Error("missing page");
    }
    return currentPage;
  }),
  ensurePageState: vi.fn(() => pageState),
  forceDisconnectPlaywrightForTarget: vi.fn(async () => {}),
  gotoPageWithNavigationGuard: vi.fn(
    async (opts: {
      url: string;
      timeoutMs: number;
      page: { goto: (url: string, init: { timeout: number }) => Promise<unknown> };
    }) => (await opts.page.goto(opts.url, { timeout: opts.timeoutMs })) ?? null,
  ),
  restoreRoleRefsForTarget: vi.fn(() => {}),
  storeRoleRefsForTarget: vi.fn(() => {}),
  refLocator: vi.fn(() => {
    if (!currentRefLocator) {
      throw new Error("missing locator");
    }
    return currentRefLocator;
  }),
  rememberRoleRefsForTarget: vi.fn(() => {}),
}));

const navigationGuardMocks = vi.hoisted(() => ({
  assertBrowserNavigationResultAllowed: vi.fn(async () => {}),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => ({ ssrfPolicy })),
}));

vi.mock("./pw-session.js", () => sessionMocks);
vi.mock("./navigation-guard.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ...navigationGuardMocks,
  };
});

export function getPwToolsCoreSessionMocks() {
  return sessionMocks;
}

export function getPwToolsCoreNavigationGuardMocks() {
  return navigationGuardMocks;
}

export function setPwToolsCoreCurrentPage(page: Record<string, unknown> | null) {
  currentPage = page;
}

export function setPwToolsCoreCurrentRefLocator(locator: Record<string, unknown> | null) {
  currentRefLocator = locator;
}

export function installPwToolsCoreTestHooks() {
  beforeEach(() => {
    currentPage = null;
    currentRefLocator = null;
    pageState = {
      console: [],
      armIdUpload: 0,
      armIdDialog: 0,
      armIdDownload: 0,
      downloadWaiterDepth: 0,
    };

    for (const fn of Object.values(sessionMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(navigationGuardMocks)) {
      fn.mockClear();
    }
  });
}
