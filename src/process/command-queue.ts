// Minimal in-process queue to serialize command executions.
// Ensures only one command runs at a time across webhook, poller, and web inbox flows.

type QueueEntry = {
	task: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (reason?: unknown) => void;
	enqueuedAt: number;
	warnAfterMs: number;
	onWait?: (waitMs: number, queuedAhead: number) => void;
};

const queue: QueueEntry[] = [];
let draining = false;

async function drainQueue() {
	if (draining) return;
	draining = true;
	while (queue.length) {
		const entry = queue.shift() as QueueEntry;
		const waitedMs = Date.now() - entry.enqueuedAt;
		if (waitedMs >= entry.warnAfterMs) {
			entry.onWait?.(waitedMs, queue.length);
		}
		try {
			const result = await entry.task();
			entry.resolve(result);
		} catch (err) {
			entry.reject(err);
		}
	}
	draining = false;
}

export function enqueueCommand<T>(
	task: () => Promise<T>,
	opts?: {
		warnAfterMs?: number;
		onWait?: (waitMs: number, queuedAhead: number) => void;
	},
): Promise<T> {
	const warnAfterMs = opts?.warnAfterMs ?? 2_000;
	return new Promise<T>((resolve, reject) => {
		queue.push({
			task: () => task(),
			resolve: (value) => resolve(value as T),
			reject,
			enqueuedAt: Date.now(),
			warnAfterMs,
			onWait: opts?.onWait,
		});
		void drainQueue();
	});
}

export function getQueueSize() {
	return queue.length + (draining ? 1 : 0);
}
