@MainActor
final class DeviceSettingsRequestQueue {
    private var generation = 0
    private var task: Task<Void, Never>?
    private var pending: [@MainActor () async -> Void] = []

    func enqueue(_ operation: @escaping @MainActor () async -> Void) {
        self.pending.append(operation)
        guard self.task == nil else { return }
        let generation = self.generation
        self.task = Task {
            // One worker owns the active operation as well as the queue, so cancellation reaches both.
            while !Task.isCancelled, self.generation == generation, !self.pending.isEmpty {
                let next = self.pending.removeFirst()
                await next()
            }
            // A closed window may reopen before its old permission prompt returns.
            if self.generation == generation { self.task = nil }
        }
    }

    func cancel() {
        self.generation += 1
        self.task?.cancel()
        self.task = nil
        self.pending.removeAll()
    }
}
