import Foundation

/// Synchronous invocation ownership, isolated by the containing GatewayNodeSession actor.
struct GatewayNodeInvocationRegistry {
    typealias Cleanup = (id: UUID, task: Task<BridgeInvokeResponse, Never>)

    private struct Invocation {
        enum State {
            case pending
            case cancelled
            case running(Task<BridgeInvokeResponse, Never>)
        }

        let requestID: String
        let admissionGeneration: UInt64
        let waitsForRouteTeardown: Bool
        var state: State = .pending

        var task: Task<BridgeInvokeResponse, Never>? {
            if case let .running(task) = self.state {
                task
            } else { nil }
        }

        mutating func cancel() {
            switch self.state {
            case .pending: self.state = .cancelled
            case let .running(task): task.cancel()
            case .cancelled: break
            }
        }
    }

    private var invocations: [UUID: Invocation] = [:]

    mutating func register(requestID: String, command: String, admissionGeneration: UInt64) -> UUID? {
        let waitsForRouteTeardown = command == OpenClawComputerCommand.act.rawValue ||
            command == OpenClawCameraCommand.ptzControl.rawValue ||
            OpenClawTalkCommand(rawValue: command) != nil
        guard waitsForRouteTeardown || command == OpenClawSystemCommand.notify.rawValue ||
            command == OpenClawChatCommand.push.rawValue || command == OpenClawWatchCommand.notify.rawValue
        else { return nil }
        let id = UUID()
        self.invocations[id] = Invocation(
            requestID: requestID,
            admissionGeneration: admissionGeneration,
            waitsForRouteTeardown: waitsForRouteTeardown)
        return id
    }

    /// The synchronous factory retains the session's actor isolation when creating
    /// its task; cancellation cannot interleave between admission and registration.
    mutating func start(
        id: UUID,
        makeTask: () -> Task<BridgeInvokeResponse, Never>) -> Task<BridgeInvokeResponse, Never>?
    {
        guard !Task.isCancelled, case .pending? = self.invocations[id]?.state else { return nil }
        let task = makeTask()
        self.invocations[id]?.state = .running(task)
        return task
    }

    mutating func finish(_ id: UUID) {
        self.invocations.removeValue(forKey: id)
    }

    mutating func discardPending(_ id: UUID?) {
        // A joined computer receipt never starts another operation. Its pending
        // admission ends here; running operations retain cleanup ownership.
        if let id, self.invocations[id]?.task == nil {
            self.finish(id)
        }
    }

    mutating func cancel(admissionGeneration: UInt64) -> [Cleanup] {
        var cleanup: [Cleanup] = []
        for (id, var invoke) in self.invocations where invoke.admissionGeneration == admissionGeneration {
            invoke.cancel()
            if invoke.waitsForRouteTeardown, let task = invoke.task {
                self.invocations[id] = invoke
                cleanup.append((id, task))
            } else {
                // Notification permission callbacks can ignore cancellation. Fence
                // their effect, but never make them hold replacement routes open.
                self.finish(id)
            }
        }
        return cleanup
    }

    mutating func cancel(requestID: String, admissionGeneration: UInt64) {
        for (id, invoke) in self.invocations
            where invoke.requestID == requestID && invoke.admissionGeneration == admissionGeneration
        {
            self.invocations[id]?.cancel()
        }
    }
}
