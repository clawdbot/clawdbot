import Foundation

public enum OpenClawHealthCommand: String, Codable, Sendable {
    case summary = "health.summary"
}

public enum OpenClawHealthSummaryPeriod: String, Codable, Sendable, CaseIterable {
    case today
}

public struct OpenClawHealthSummaryParams: Codable, Sendable, Equatable {
    public var period: OpenClawHealthSummaryPeriod

    public init(period: OpenClawHealthSummaryPeriod) {
        self.period = period
    }
}

public struct OpenClawHealthSummaryPayload: Codable, Sendable, Equatable {
    public var period: OpenClawHealthSummaryPeriod
    public var startISO: String
    public var endISO: String
    public var timeZoneIdentifier: String
    public var stepCount: Int?
    public var sleepDurationMinutes: Int?
    public var restingHeartRateBpm: Double?
    public var workoutCount: Int?
    public var workoutDurationMinutes: Int?

    public init(
        period: OpenClawHealthSummaryPeriod,
        startISO: String,
        endISO: String,
        timeZoneIdentifier: String,
        stepCount: Int?,
        sleepDurationMinutes: Int?,
        restingHeartRateBpm: Double?,
        workoutCount: Int?,
        workoutDurationMinutes: Int?)
    {
        self.period = period
        self.startISO = startISO
        self.endISO = endISO
        self.timeZoneIdentifier = timeZoneIdentifier
        self.stepCount = stepCount
        self.sleepDurationMinutes = sleepDurationMinutes
        self.restingHeartRateBpm = restingHeartRateBpm
        self.workoutCount = workoutCount
        self.workoutDurationMinutes = workoutDurationMinutes
    }
}
