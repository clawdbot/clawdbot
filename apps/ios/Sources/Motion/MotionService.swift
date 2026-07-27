import CoreMotion
import Foundation
import OpenClawKit

final class MotionService: MotionServicing {
    func activities(params: OpenClawMotionActivityParams) async throws -> OpenClawMotionActivityPayload {
        guard CMMotionActivityManager.isActivityAvailable() else {
            throw NSError(domain: "Motion", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "MOTION_UNAVAILABLE: activity not supported on this device",
            ])
        }
        let auth = CMMotionActivityManager.authorizationStatus()
        guard auth == .authorized else {
            throw NSError(domain: "Motion", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "MOTION_PERMISSION_REQUIRED: grant Motion & Fitness permission",
            ])
        }

        let (start, end) = Self.resolveRange(startISO: params.startISO, endISO: params.endISO)
        let limit = max(1, min(params.limit ?? 200, 1000))

        let manager = CMMotionActivityManager()
        let mapped: [OpenClawMotionActivityEntry] = try await withCheckedThrowingContinuation { cont in
            manager.queryActivityStarting(from: start, to: end, to: OperationQueue()) { activity, error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    let formatter = ISO8601DateFormatter()
                    let sliced = Array((activity ?? []).suffix(limit))
                    let entries = sliced.map { entry in
                        OpenClawMotionActivityEntry(
                            startISO: formatter.string(from: entry.startDate),
                            endISO: formatter.string(from: end),
                            confidence: Self.confidenceString(entry.confidence),
                            isWalking: entry.walking,
                            isRunning: entry.running,
                            isCycling: entry.cycling,
                            isAutomotive: entry.automotive,
                            isStationary: entry.stationary,
                            isUnknown: entry.unknown)
                    }
                    cont.resume(returning: entries)
                }
            }
        }

        return OpenClawMotionActivityPayload(activities: mapped)
    }

    func pedometer(params: OpenClawPedometerParams) async throws -> OpenClawPedometerPayload {
        guard CMPedometer.isStepCountingAvailable() else {
            throw NSError(domain: "Motion", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "PEDOMETER_UNAVAILABLE: step counting not supported",
            ])
        }
        let auth = CMPedometer.authorizationStatus()
        guard auth == .authorized else {
            throw NSError(domain: "Motion", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "MOTION_PERMISSION_REQUIRED: grant Motion & Fitness permission",
            ])
        }

        let (start, end) = Self.resolveRange(startISO: params.startISO, endISO: params.endISO)
        let pedometer = CMPedometer()
        return try await withCheckedThrowingContinuation { cont in
            pedometer.queryPedometerData(from: start, to: end) { data, error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    let formatter = ISO8601DateFormatter()
                    let payload = OpenClawPedometerPayload(
                        startISO: formatter.string(from: start),
                        endISO: formatter.string(from: end),
                        steps: data?.numberOfSteps.intValue,
                        distanceMeters: data?.distance?.doubleValue,
                        floorsAscended: data?.floorsAscended?.intValue,
                        floorsDescended: data?.floorsDescended?.intValue)
                    cont.resume(returning: payload)
                }
            }
        }
    }

    private static func resolveRange(startISO: String?, endISO: String?) -> (Date, Date) {
        let formatter = ISO8601DateFormatter()
        let start = startISO.flatMap { formatter.date(from: $0) } ?? Calendar.current.startOfDay(for: Date())
        let end = endISO.flatMap { formatter.date(from: $0) } ?? Date()
        return (start, end)
    }

    private static func confidenceString(_ confidence: CMMotionActivityConfidence) -> String {
        switch confidence {
        case .low: "low"
        case .medium: "medium"
        case .high: "high"
        @unknown default: "unknown"
        }
    }
}
