// Keeps pending task actions controllable through the real terminal input loop.
export const TUI_PTY_TASK_FIXTURE = {
  variables: `
      let pendingTaskSuggestion: {
        id: string;
        title: string;
        prompt: string;
        tldr: string;
        cwd: string;
        sessionKey: string;
        agentId: string;
        createdAt: number;
      } | null = null;

      async function waitForTaskRelease() {
        const releasePath = process.env.OPENCLAW_TUI_PTY_TASK_RELEASE_PATH;
        if (releasePath) {
          while (!existsSync(releasePath)) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
      }
  `,
  methods: `
        async listTaskSuggestions() {
          record("listTaskSuggestions", { pending: Boolean(pendingTaskSuggestion) });
          return pendingTaskSuggestion ? [pendingTaskSuggestion] : [];
        }

        async acceptTaskSuggestion(taskId: string) {
          record("acceptTaskSuggestion", { taskId });
          await waitForTaskRelease();
          pendingTaskSuggestion = null;
          this.onEvent?.({
            event: "task.suggestion",
            payload: { action: "resolved", taskId, resolution: "accepted" },
          });
          return { taskId, key: "agent:main:task-pty" };
        }

        async dismissTaskSuggestion(taskId: string) {
          record("dismissTaskSuggestion", { taskId });
          await waitForTaskRelease();
          pendingTaskSuggestion = null;
          this.onEvent?.({
            event: "task.suggestion",
            payload: { action: "resolved", taskId, resolution: "dismissed" },
          });
          return { taskId, dismissed: true };
        }
  `,
} as const;
