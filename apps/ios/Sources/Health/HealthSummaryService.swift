import Foundation
import HealthKit
import OpenClawKit

enum HealthAuthorization {
    static let enabledKey = "health.summary.enabled"

    static var isAvailable: Bool {
        HKHealthStore.isHealthDataAvailable()
    }

    static var isEnabled: Bool {
        self.isAvailable && UserDefaults.standard.bool(forKey: self.enabledKey)
    }

    static var readTypes: Set<HKObjectType> {
        var types: Set<HKObjectType> = [HKWorkoutType.workoutType()]
        if let steps = HKObjectType.quantityType(forIdentifier: .stepCount) {
            types.insert(steps)
        }
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            types.insert(sleep)
        }
        if let restingHeartRate = HKObjectType.quantityType(forIdentifier: .restingHeartRate) {
            types.insert(restingHeartRate)
        }
        return types
    }

    @MainActor
    static func enable() async throws {
        guard self.isAvailable else {
            throw NSError(domain: "Health", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Health data is unavailable on this device.",
            ])
        }
        try await HKHealthStore().requestAuthorization(toShare: [], read: self.readTypes)
        // HealthKit intentionally does not reveal read denial. This flag records only
        // the user's explicit OpenClaw sharing choice, never inferred authorization.
        UserDefaults.standard.set(true, forKey: self.enabledKey)
    }

    static func disable() {
        UserDefaults.standard.removeObject(forKey: self.enabledKey)
    }
}

protocol HealthSummaryServicing: Sendable {
    func summary(params: OpenClawHealthSummaryParams) async throws -> OpenClawHealthSummaryPayload
}

actor HealthSummaryService: HealthSummaryServicing {
    private let healthStore: HKHealthStore

    init(healthStore: HKHealthStore = HKHealthStore()) {
        self.healthStore = healthStore
    }

    func summary(params: OpenClawHealthSummaryParams) async throws -> OpenClawHealthSummaryPayload {
        guard HealthAuthorization.isEnabled else {
            throw NSError(domain: "Health", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "HEALTH_ACCESS_DISABLED: enable Health Summaries in OpenClaw Settings",
            ])
        }

        let now = Date()
        let range = Self.dateRange(now: now, calendar: .current)
        let stepCount = try await self.stepCount(in: range)
        let sleepDuration = try await self.sleepDuration(in: range)
        let restingHeartRate = try await self.restingHeartRate(in: range)
        let workouts = try await self.workouts(in: range)
        let formatter = ISO8601DateFormatter()

        return OpenClawHealthSummaryPayload(
            period: params.period,
            startISO: formatter.string(from: range.start),
            endISO: formatter.string(from: range.end),
            timeZoneIdentifier: TimeZone.current.identifier,
            stepCount: stepCount,
            sleepDurationMinutes: sleepDuration.map(Self.roundedMinutes),
            restingHeartRateBpm: restingHeartRate.map { ($0 * 10).rounded() / 10 },
            workoutCount: workouts?.count,
            workoutDurationMinutes: workouts.map { Self.roundedMinutes($0.duration) })
    }

    static func dateRange(
        now: Date,
        calendar: Calendar) -> DateInterval
    {
        let startOfToday = calendar.startOfDay(for: now)
        return DateInterval(start: startOfToday, end: now)
    }

    static func mergedDuration(
        intervals: [DateInterval],
        clippedTo range: DateInterval) -> TimeInterval?
    {
        let clipped = intervals.compactMap { interval -> DateInterval? in
            let start = max(interval.start, range.start)
            let end = min(interval.end, range.end)
            return end > start ? DateInterval(start: start, end: end) : nil
        }.sorted { $0.start < $1.start }
        guard var current = clipped.first else { return nil }

        var duration: TimeInterval = 0
        for interval in clipped.dropFirst() {
            if interval.start <= current.end {
                current = DateInterval(start: current.start, end: max(current.end, interval.end))
            } else {
                duration += current.duration
                current = interval
            }
        }
        return duration + current.duration
    }

    private static func roundedMinutes(_ seconds: TimeInterval) -> Int {
        Int((seconds / 60).rounded())
    }

    private func stepCount(in range: DateInterval) async throws -> Int? {
        guard let type = HKObjectType.quantityType(forIdentifier: .stepCount) else { return nil }
        let predicate = Self.quantityPredicate(type: type, range: range)
        let statistics = try await HKStatisticsQueryDescriptor(
            predicate: predicate,
            options: .cumulativeSum).result(for: self.healthStore)
        return statistics?.sumQuantity().map { Int($0.doubleValue(for: .count()).rounded()) }
    }

    private func restingHeartRate(in range: DateInterval) async throws -> Double? {
        guard let type = HKObjectType.quantityType(forIdentifier: .restingHeartRate) else { return nil }
        let predicate = Self.quantityPredicate(type: type, range: range)
        let statistics = try await HKStatisticsQueryDescriptor(
            predicate: predicate,
            options: .discreteAverage).result(for: self.healthStore)
        let beatsPerMinute = HKUnit.count().unitDivided(by: .minute())
        return statistics?.averageQuantity()?.doubleValue(for: beatsPerMinute)
    }

    private func sleepDuration(in range: DateInterval) async throws -> TimeInterval? {
        guard let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else { return nil }
        let predicate = HKQuery.predicateForSamples(
            withStart: range.start,
            end: range.end,
            options: [])
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.categorySample(type: type, predicate: predicate)],
            sortDescriptors: [],
            limit: nil)
        let samples = try await descriptor.result(for: self.healthStore)
        let asleepIntervals = samples.compactMap { sample -> DateInterval? in
            guard let value = HKCategoryValueSleepAnalysis(rawValue: sample.value),
                  HKCategoryValueSleepAnalysis.allAsleepValues.contains(value)
            else { return nil }
            return DateInterval(start: sample.startDate, end: sample.endDate)
        }
        // Sleep stages and sources can overlap. Merge intervals so a minute is
        // never counted twice in the aggregate sent off device.
        return Self.mergedDuration(intervals: asleepIntervals, clippedTo: range)
    }

    private func workouts(in range: DateInterval) async throws -> (count: Int, duration: TimeInterval)? {
        let predicate = HKQuery.predicateForSamples(
            withStart: range.start,
            end: range.end,
            options: .strictStartDate)
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.workout(predicate)],
            sortDescriptors: [],
            limit: nil)
        let samples = try await descriptor.result(for: self.healthStore)
        guard !samples.isEmpty else { return nil }
        let duration = samples.reduce(0) { $0 + $1.duration }
        return (samples.count, duration)
    }

    private static func quantityPredicate(
        type: HKQuantityType,
        range: DateInterval) -> HKSamplePredicate<HKQuantitySample>
    {
        let predicate = HKQuery.predicateForSamples(
            withStart: range.start,
            end: range.end,
            options: [])
        return .quantitySample(type: type, predicate: predicate)
    }
}
