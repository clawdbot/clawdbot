export type PageSharePayload = {
  url: string;
  title: string;
  content: string;
  selection?: string;
  note?: string;
};

export type PageCapture = {
  url: string;
  title: string;
  selection: string;
  content: string;
};

export function waitForCondition(condition: () => boolean, timeoutMs: number): Promise<boolean>;
export function buildPageSharePayload(params: {
  url: string;
  title: string;
  content: string;
  selection?: string;
  note?: string;
}): PageSharePayload;
export function capturePageShare(tab: {
  id?: number;
  url?: string;
  title?: string;
}): Promise<PageCapture>;
