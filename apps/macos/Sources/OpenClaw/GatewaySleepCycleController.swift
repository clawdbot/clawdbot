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

    private let requestID: String
    private let currentRoute: CurrentRoute
    private let prepare: Prepare
    private let resume: Resume
    private let refresh: Refresh
    private let log: (String) -> Void
    private var suspension: (id: String, route: String?)?
    private var cycleGeneration: UInt64 = 0

    init(
        requestID: String,
        currentRoute: @escaping CurrentRoute,
        prepare: @escaping Prepare,
        resume: @escaping Resume,
        refresh: @escaping Refresh,
        log: @escaping (String) -> Void)
    {
        self.requestID = requestID
        self.currentRoute = currentRoute
        self.prepare = prepare
        self.resume = resume
        self.refresh = refresh
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
        if let suspension {
            if let route = suspension.route, self.currentRoute() == route {
                do {
                    try await self.resume(suspension.id)
                } catch {
                    self.log("gateway wake resume failed: \(error.localizedDescription)")
                }
            } else {
                self.log("dropping gateway sleep lease: route/mode changed across sleep; lease will self-expire")
            }
        }
        await self.refresh()
    }
}
