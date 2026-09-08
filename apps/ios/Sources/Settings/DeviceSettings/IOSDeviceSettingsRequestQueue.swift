import Foundation

@MainActor
final class IOSDeviceSettingsRequestQueue {
    private struct Operation {
        let run: @MainActor () async -> Void
        let cancel: @MainActor () -> Void
    }

    private var generation = 0
    private var worker: Task<Void, Never>?
    private var active: Operation?
    private var pending: [Operation] = []

    func enqueue(
        operation: @escaping @MainActor () async -> Void,
        onCancel: @escaping @MainActor () -> Void)
    {
        self.pending.append(Operation(run: operation, cancel: onCancel))
        guard self.worker == nil else { return }
        let generation = self.generation
        self.worker = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, self.generation == generation, !self.pending.isEmpty {
                let operation = self.pending.removeFirst()
                self.active = operation
                await operation.run()
                guard self.generation == generation else { return }
                self.active = nil
            }
            if self.generation == generation { self.worker = nil }
        }
    }

    func cancel() {
        self.generation += 1
        self.worker?.cancel()
        self.worker = nil
        let retired = self.pending
        let active = self.active
        self.pending.removeAll()
        self.active = nil
        // Reject every Promise now, even when a system permission prompt ignores cancellation.
        active?.cancel()
        for operation in retired {
            operation.cancel()
        }
    }
}

@MainActor
final class IOSDeviceSettingsReply {
    typealias Handler = @MainActor (Any?, String?) -> Void

    private var handler: Handler?

    init(_ handler: @escaping Handler) {
        self.handler = handler
    }

    func finish(_ value: Any? = nil, error: String? = nil) {
        let handler = self.handler
        self.handler = nil
        handler?(value, error)
    }

    func retire() {
        self.finish(error: "The device settings document is no longer available.")
    }
}
