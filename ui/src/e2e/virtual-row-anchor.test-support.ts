import type { Locator } from "playwright";
import { expect } from "vitest";

type VisibleVirtualRow = {
  index: number;
  key: string;
  totalSize: number;
  viewportTop: number;
};

type VirtualRowPaintSample = {
  index: number | null;
  intersectsViewport: boolean;
  totalSize: number;
  viewportTop: number | null;
};

type VirtualRowPaintProbe = {
  frameIds: number[];
  observer: MutationObserver;
  pendingSamples: number;
  samples: VirtualRowPaintSample[];
  timerIds: number[];
};

export type VirtualRowPaintResult = {
  pending: boolean;
  samples: VirtualRowPaintSample[];
};

export async function captureTopVisibleVirtualRow(thread: Locator): Promise<VisibleVirtualRow> {
  return thread.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const row = Array.from(
      element.querySelectorAll<HTMLElement>(".chat-virtual-row[data-virtual-row-key]"),
    ).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    if (!row) {
      throw new Error("expected a visible virtual transcript row");
    }
    const index = Number.parseInt(row.dataset.index ?? "", 10);
    if (!Number.isFinite(index)) {
      throw new Error("expected the virtual transcript anchor to expose its row index");
    }
    return {
      index,
      key: row.dataset.virtualRowKey ?? "",
      totalSize:
        element.querySelector<HTMLElement>(".chat-virtual-sizer")?.getBoundingClientRect().height ??
        0,
      viewportTop: row.getBoundingClientRect().top - viewport.top,
    };
  });
}

export async function startVirtualRowPaintProbe(thread: Locator, anchor: VisibleVirtualRow) {
  await thread.evaluate((element, expected) => {
    const target = globalThis as typeof globalThis & {
      chatPrependPaintProbe?: VirtualRowPaintProbe;
    };
    const staleProbe = target.chatPrependPaintProbe;
    if (staleProbe) {
      staleProbe.observer.disconnect();
      staleProbe.frameIds.forEach((frameId) => cancelAnimationFrame(frameId));
      staleProbe.timerIds.forEach((timerId) => clearTimeout(timerId));
      delete target.chatPrependPaintProbe;
    }
    const probe: VirtualRowPaintProbe = {
      frameIds: [],
      observer: new MutationObserver(() => undefined),
      pendingSamples: 0,
      samples: [],
      timerIds: [],
    };
    const sample = () => {
      const viewport = element.getBoundingClientRect();
      const row = Array.from(
        element.querySelectorAll<HTMLElement>(".chat-virtual-row[data-virtual-row-key]"),
      ).find((candidate) => candidate.dataset.virtualRowKey === expected.key);
      const rect = row?.getBoundingClientRect();
      const index = row ? Number.parseInt(row.dataset.index ?? "", 10) : Number.NaN;
      probe.samples.push({
        index: Number.isFinite(index) ? index : null,
        intersectsViewport: Boolean(
          rect && rect.bottom > viewport.top && rect.top < viewport.bottom,
        ),
        totalSize:
          element.querySelector<HTMLElement>(".chat-virtual-sizer")?.getBoundingClientRect()
            .height ?? 0,
        viewportTop: rect ? rect.top - viewport.top : null,
      });
    };
    const removePendingId = (ids: number[], id: number) => {
      const index = ids.indexOf(id);
      if (index !== -1) {
        ids.splice(index, 1);
      }
    };
    const scheduleSample = () => {
      // Each mutation batch owns a post-paint sample; later mutations must not
      // cancel an earlier frame that could expose a visible anchor jump.
      probe.pendingSamples += 1;
      const firstFrame = requestAnimationFrame(() => {
        removePendingId(probe.frameIds, firstFrame);
        const secondFrame = requestAnimationFrame(() => {
          removePendingId(probe.frameIds, secondFrame);
          const timerId = window.setTimeout(() => {
            removePendingId(probe.timerIds, timerId);
            sample();
            probe.pendingSamples -= 1;
          }, 0);
          probe.timerIds.push(timerId);
        });
        probe.frameIds.push(secondFrame);
      });
      probe.frameIds.push(firstFrame);
    };
    probe.observer = new MutationObserver(scheduleSample);
    probe.observer.observe(element, {
      attributeFilter: ["style"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    target.chatPrependPaintProbe = probe;
  }, anchor);
}

async function readVirtualRowPaintProbe(thread: Locator) {
  return thread.evaluate(() => {
    const probe = (
      globalThis as typeof globalThis & {
        chatPrependPaintProbe?: VirtualRowPaintProbe;
      }
    ).chatPrependPaintProbe;
    if (!probe) {
      throw new Error("expected an active virtual row paint probe");
    }
    return {
      pendingSamples: probe.pendingSamples,
      samples: probe.samples,
    };
  });
}

export async function stopVirtualRowPaintProbe(thread: Locator): Promise<VirtualRowPaintResult> {
  return thread.evaluate(() => {
    const target = globalThis as typeof globalThis & {
      chatPrependPaintProbe?: VirtualRowPaintProbe;
    };
    const probe = target.chatPrependPaintProbe;
    if (!probe) {
      throw new Error("expected an active virtual row paint probe");
    }
    const pending = probe.pendingSamples > 0;
    probe.observer.disconnect();
    probe.frameIds.forEach((frameId) => cancelAnimationFrame(frameId));
    probe.timerIds.forEach((timerId) => clearTimeout(timerId));
    delete target.chatPrependPaintProbe;
    return { pending, samples: probe.samples };
  });
}

function virtualRowAnchorStatus(anchor: VisibleVirtualRow, samples: VirtualRowPaintSample[]) {
  return {
    advanced: samples.some(
      (sample) =>
        (sample.index !== null && sample.index > anchor.index) ||
        sample.totalSize > anchor.totalSize,
    ),
    anchored: samples.every(
      (sample) =>
        sample.viewportTop !== null && Math.abs(sample.viewportTop - anchor.viewportTop) <= 2,
    ),
    present: samples.length > 0 && samples.every((sample) => sample.viewportTop !== null),
    visible: samples.every((sample) => sample.intersectsViewport),
  };
}

export async function waitForPaintedVirtualRowAnchor(thread: Locator, anchor: VisibleVirtualRow) {
  await expect
    .poll(async () => {
      const probe = await readVirtualRowPaintProbe(thread);
      return probe.pendingSamples === 0 && virtualRowAnchorStatus(anchor, probe.samples).advanced;
    })
    .toBe(true);
}

export function expectPaintedVirtualRowAnchor(
  anchor: VisibleVirtualRow,
  result: VirtualRowPaintResult,
) {
  const evidence = JSON.stringify({ anchor, ...result });
  expect(
    { pending: result.pending, ...virtualRowAnchorStatus(anchor, result.samples) },
    evidence,
  ).toEqual({
    pending: false,
    advanced: true,
    anchored: true,
    present: true,
    visible: true,
  });
}
