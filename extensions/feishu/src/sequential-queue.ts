export function createSequentialQueue() {
  const queues = new Map<string, Promise<void>>();

  return (key: string, task: () => Promise<void>): Promise<void> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    queues.set(key, next);
    const cleanup = () => {
      if (queues.get(key) === next) {
        queues.delete(key);
      }
    };
    next.then(cleanup, cleanup);
    return next;
  };
}
