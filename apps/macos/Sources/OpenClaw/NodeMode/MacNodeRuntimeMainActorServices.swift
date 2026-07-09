import CoreLocation
import Foundation
import OpenClawKit

@MainActor
protocol MacNodeRuntimeMainActorServices: Sendable {
    func snapshotScreen(
        screenIndex: Int?,
        maxWidth: Int?,
        quality: Double?,
        format: OpenClawScreenSnapshotFormat?) async throws
        -> (data: Data, format: OpenClawScreenSnapshotFormat, width: Int, height: Int)

    func recordScreen(
        screenIndex: Int?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool?,
        outPath: String?) async throws -> (path: String, hasAudio: Bool)

    func locationAuthorizationStatus() -> CLAuthorizationStatus
    func locationAccuracyAuthorization() -> CLAccuracyAuthorization
    func currentLocation(
        desiredAccuracy: OpenClawLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation

    func performComputerAct(_ params: OpenClawComputerActParams) async throws -> OpenClawComputerActResult
    func releaseHeldInput()
}

@MainActor
final class LiveMacNodeRuntimeMainActorServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
    private let screenSnapshotter = ScreenSnapshotService()
    private let screenRecorder = ScreenRecordService()
    private let locationService = MacNodeLocationService()
    private let computerAction = ComputerActionService()

    func snapshotScreen(
        screenIndex: Int?,
        maxWidth: Int?,
        quality: Double?,
        format: OpenClawScreenSnapshotFormat?) async throws
        -> (data: Data, format: OpenClawScreenSnapshotFormat, width: Int, height: Int)
    {
        try await self.screenSnapshotter.snapshot(
            screenIndex: screenIndex,
            maxWidth: maxWidth,
            quality: quality,
            format: format)
    }

    func recordScreen(
        screenIndex: Int?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool?,
        outPath: String?) async throws -> (path: String, hasAudio: Bool)
    {
        try await self.screenRecorder.record(
            screenIndex: screenIndex,
            durationMs: durationMs,
            fps: fps,
            includeAudio: includeAudio,
            outPath: outPath)
    }

    func locationAuthorizationStatus() -> CLAuthorizationStatus {
        self.locationService.authorizationStatus()
    }

    func locationAccuracyAuthorization() -> CLAccuracyAuthorization {
        self.locationService.accuracyAuthorization()
    }

    func currentLocation(
        desiredAccuracy: OpenClawLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
    {
        try await self.locationService.currentLocation(
            desiredAccuracy: desiredAccuracy,
            maxAgeMs: maxAgeMs,
            timeoutMs: timeoutMs)
    }

    func performComputerAct(_ params: OpenClawComputerActParams) async throws -> OpenClawComputerActResult {
        try await self.computerAction.perform(params)
    }

    func releaseHeldInput() {
        self.computerAction.releaseHeldInput()
    }
}
