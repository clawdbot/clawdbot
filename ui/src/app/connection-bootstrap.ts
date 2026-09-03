/** Coordinates automatic Control UI bootstrap work for one Gateway connection epoch. */

export type ConnectionBootstrapCoordinator = {
  reset: () => void;
  run: (key: string, task: () => Promise<unknown>) => Promise<void>;
  synchronize: (params: { client: object | null; connected: boolean }) => void;
};

const MAX_CONNECTION_BOOTSTRAP_CONCURRENCY = 2;

type QueuedBootstrapTask = {
  generation: number;
  key: string;
  resolve: () => void;
  run: () => Promise<unknown>;
};

/** Owns the queue and revokes pending work synchronously with its connection epoch. */
export function createConnectionBootstrapCoordinator(): ConnectionBootstrapCoordinator {
  let client: object | null = null;
  let generation = 0;
  let active = 0;
  const queued: QueuedBootstrapTask[] = [];
  const tasks = new Map<string, Promise<void>>();

  const drain = () => {
    while (active < MAX_CONNECTION_BOOTSTRAP_CONCURRENCY) {
      const task = queued.shift();
      if (!task) {
        return;
      }
      if (task.generation !== generation) {
        task.resolve();
        continue;
      }
      if (!client) {
        queued.unshift(task);
        return;
      }
      active++;
      const finish = () => {
        if (task.generation === generation) {
          tasks.delete(task.key);
        }
        task.resolve();
      };
      void task
        .run()
        .then(finish, finish)
        .finally(() => {
          active--;
          drain();
        });
    }
  };

  const reset = () => {
    generation += 1;
    client = null;
    queued.splice(0).forEach((task) => task.resolve());
    tasks.clear();
  };

  return {
    reset,
    synchronize(params) {
      const nextClient = params.connected ? params.client : null;
      if (nextClient === client) {
        // A connected snapshot can publish before this coordinator's listener
        // runs. A later disconnected snapshot invalidates that queued work.
        if (!nextClient && queued.length) {
          reset();
        }
        return;
      }
      if (!nextClient) {
        reset();
        return;
      }
      if (client) {
        reset();
      }
      client = nextClient;
      drain();
    },
    run(key, task) {
      const current = tasks.get(key);
      if (current) {
        return current;
      }
      let resolve!: () => void;
      const scheduled = new Promise<void>((resolveTask) => {
        resolve = resolveTask;
      });
      tasks.set(key, scheduled);
      queued.push({ generation, key, resolve, run: task });
      drain();
      return scheduled;
    },
  };
}
