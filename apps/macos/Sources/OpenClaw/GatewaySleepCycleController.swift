import Foundation

enum GatewaySleepPrepareResult: Equatable {
    case ready(suspensionID: String)
    case busy
}

@MainActor
final class GatewaySleepCycleController {
    typealias Prepare = (String) async throws -> GatewaySleepPrepareResult
    typealias Resume = (String) async throws -> Void
    typealias Refresh = () async -> Void
    typealias CurrentRoute = () -> String?
    typealias RetryDelay = (Duration) async -> Void

    private static let resumeAttempts = 3
    private static let resumeRetryDelay: Duration = .seconds(2)

    private let requestID: String
    private let currentRoute: CurrentRoute
    private let prepare: Prepare
    private let resume: Resume
    private let refresh: Refresh
    private let retryDelay: RetryDelay
    private let log: (String) -> Void
    private var suspension: (id: String, route: String?)?
    private var cycleGeneration: UInt64 = 0

    init(
        requestID: String,
        currentRoute: @escaping CurrentRoute,
        prepare: @escaping Prepare,
        resume: @escaping Resume,
        refresh: @escaping Refresh,
        retryDelay: @escaping RetryDelay = { try? await Task.sleep(for: $0) },
        log: @escaping (String) -> Void)
    {
        self.requestID = requestID
        self.currentRoute = currentRoute
        self.prepare = prepare
        self.resume = resume
        self.refresh = refresh
        self.retryDelay = retryDelay
        self.log = log
    }

    func willSleep(mode: AppState.ConnectionMode?) async {
        guard mode == .local else { return }
        self.cycleGeneration &+= 1
        let generation = self.cycleGeneration
        do {
            switch try await self.prepare(self.requestID) {
            case let .ready(suspensionID):
                guard generation == self.cycleGeneration else {
                    // The wake already happened; release the late lease right away
                    // instead of fencing the gateway until its two-minute expiry.
                    try await self.resume(suspensionID)
                    return
                }
                self.suspension = (id: suspensionID, route: self.currentRoute())
            case .busy:
                self.log("gateway sleep preparation skipped because the gateway is busy")
            }
        } catch {
            self.log("gateway sleep preparation failed: \(error.localizedDescription)")
        }
    }

    func didWake(mode: AppState.ConnectionMode?) async {
        let suspension = self.suspension
        self.suspension = nil
        // Invalidate a prepare response that arrives after the wake notification;
        // its short-lived lease must expire instead of surviving into a later cycle.
        self.cycleGeneration &+= 1
        guard mode == .local else {
            if suspension != nil {
                self.log("dropping gateway sleep lease: route/mode changed across sleep; lease will self-expire")
            }
            return
        }
        let generation = self.cycleGeneration
        // Refresh first: after real sleep the transport is usually dead, and the
        // resume RPC needs the re-established connection to succeed at all.
        await self.refresh()
        if let suspension {
            if let route = suspension.route, self.currentRoute() == route {
                await self.resumeWithRetries(suspension.id, generation: generation)
            } else {
                self.log("dropping gateway sleep lease: route/mode changed across sleep; lease will self-expire")
            }
        }
    }

    private func resumeWithRetries(_ suspensionID: String, generation: UInt64) async {
        for attempt in 1...Self.resumeAttempts {
            // A new sleep cycle owns the connection; abandoned leases self-expire.
            guard generation == self.cycleGeneration else { return }
            do {
                try await self.resume(suspensionID)
                return
            } catch {
                self.log("gateway wake resume attempt \(attempt) failed: \(error.localizedDescription)")
                if attempt < Self.resumeAttempts {
                    await self.retryDelay(Self.resumeRetryDelay)
                }
            }
        }
        self.log("giving up on gateway wake resume; lease will self-expire")
    }
}
