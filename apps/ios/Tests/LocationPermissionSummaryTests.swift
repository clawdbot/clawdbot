import CoreLocation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.serialized) struct LocationPermissionSummaryTests {
    @Test func `always desired when in use authorized needs attention`() {
        let summary = LocationPermissionSummary(
            desiredMode: .always,
            locationServicesEnabled: true,
            authorizationStatus: .authorizedWhenInUse,
            accuracyAuthorization: .fullAccuracy)

        #expect(summary.effectiveMode == .whileUsing)
        #expect(!summary.canUseLocationInBackground)
        #expect(summary.needsAttention)
        #expect(summary.statusText == "While Using")
        #expect(summary.detailText.contains("Always is selected"))
    }

    @Test func `always desired authorized always allows background`() {
        let summary = LocationPermissionSummary(
            desiredMode: .always,
            locationServicesEnabled: true,
            authorizationStatus: .authorizedAlways,
            accuracyAuthorization: .reducedAccuracy)

        #expect(summary.effectiveMode == .always)
        #expect(summary.canUseLocationInBackground)
        #expect(!summary.needsAttention)
        #expect(summary.detailText.contains("Background location requests"))
        #expect(summary.detailText.contains("Precise Location is off"))
    }

    @Test func `off desired ignores granted permission`() {
        let summary = LocationPermissionSummary(
            desiredMode: .off,
            locationServicesEnabled: false,
            authorizationStatus: .authorizedAlways,
            accuracyAuthorization: .fullAccuracy)

        #expect(summary.effectiveMode == .off)
        #expect(!summary.canUseLocationInBackground)
        #expect(!summary.needsAttention)
        #expect(summary.detailText.contains("Location sharing is disabled"))
        #expect(summary.detailText.contains("Location Services are off"))
    }

    @Test func `off desired still reports ios always grant`() {
        let summary = LocationPermissionSummary(
            desiredMode: .off,
            locationServicesEnabled: true,
            authorizationStatus: .authorizedAlways,
            accuracyAuthorization: .fullAccuracy)

        #expect(summary.effectiveMode == .off)
        #expect(!summary.canUseLocationInBackground)
        #expect(!summary.needsAttention)
        #expect(summary.detailText.contains("Location sharing is disabled"))
        #expect(summary.detailText.contains("Always"))
    }

    @Test func `off desired still reports ios while using grant`() {
        let summary = LocationPermissionSummary(
            desiredMode: .off,
            locationServicesEnabled: true,
            authorizationStatus: .authorizedWhenInUse,
            accuracyAuthorization: .fullAccuracy)

        #expect(summary.effectiveMode == .off)
        #expect(!summary.canUseLocationInBackground)
        #expect(!summary.needsAttention)
        #expect(summary.detailText.contains("Location sharing is disabled"))
        #expect(summary.detailText.contains("While Using"))
    }

    @Test func `disabled location services override app grant`() {
        let summary = LocationPermissionSummary(
            desiredMode: .always,
            locationServicesEnabled: false,
            authorizationStatus: .authorizedAlways,
            accuracyAuthorization: .fullAccuracy)

        #expect(summary.effectiveMode == .off)
        #expect(!summary.canUseLocationInBackground)
        #expect(summary.needsAttention)
        #expect(summary.statusText == "Off")
        #expect(summary.detailText == "Location Services are off in iOS Settings.")
    }

    @Test func `initial authorization wait ignores undetermined callbacks`() {
        #expect(!LocationService.shouldCompleteAuthorizationWait(
            status: .notDetermined,
            requiresDeterminedStatus: true))
        #expect(LocationService.shouldCompleteAuthorizationWait(
            status: .authorizedWhenInUse,
            requiresDeterminedStatus: true))
        #expect(LocationService.shouldCompleteAuthorizationWait(
            status: .denied,
            requiresDeterminedStatus: true))
        #expect(LocationService.shouldCompleteAuthorizationWait(
            status: .notDetermined,
            requiresDeterminedStatus: false))
        #expect(LocationService.shouldCompleteAuthorizationWait(
            status: .notDetermined,
            requiresDeterminedStatus: true,
            allowUndeterminedFallback: true))
    }

    @MainActor @Test func `off mode stops significant location monitoring`() async {
        let locationService = MockLocationService(authorizationStatus: .authorizedAlways)
        let appModel = NodeAppModel(locationService: locationService)

        let granted = await appModel.requestLocationPermissions(mode: .off)

        #expect(granted)
        #expect(locationService.backgroundUpdatesEnabled == false)
        #expect(locationService.stopMonitoringCallCount == 1)
    }

    @MainActor @Test func `while using mode stops significant location monitoring when always remains granted`() async {
        let locationService = MockLocationService(authorizationStatus: .authorizedAlways)
        let appModel = NodeAppModel(locationService: locationService)

        let granted = await appModel.requestLocationPermissions(mode: .whileUsing)

        #expect(granted)
        #expect(locationService.backgroundUpdatesEnabled == false)
        #expect(locationService.stopMonitoringCallCount == 1)
    }

    @MainActor @Test func `always mode starts significant location monitoring when always is granted`() async {
        let locationService = MockLocationService(authorizationStatus: .authorizedAlways)
        let appModel = NodeAppModel(locationService: locationService)

        let granted = await appModel.requestLocationPermissions(mode: .always)

        #expect(granted)
        #expect(locationService.backgroundUpdatesEnabled == true)
        #expect(locationService.stopMonitoringCallCount == 0)
        #expect(locationService.startMonitoringCallCount == 1)
    }

    @MainActor @Test func `always mode remains selected when ios only grants while using`() async {
        let locationService = MockLocationService(authorizationStatus: .authorizedWhenInUse)
        let appModel = NodeAppModel(locationService: locationService)

        let granted = await appModel.requestLocationPermissions(mode: .always)

        #expect(granted)
        #expect(locationService.backgroundUpdatesEnabled == false)
        #expect(locationService.stopMonitoringCallCount == 1)
    }

    @MainActor @Test func `retired location settings request cannot start monitoring or change sharing`() async {
        let defaultsKey = "location.enabledMode"
        let previous = UserDefaults.standard.object(forKey: defaultsKey)
        defer {
            if let previous {
                UserDefaults.standard.set(previous, forKey: defaultsKey)
            } else {
                UserDefaults.standard.removeObject(forKey: defaultsKey)
            }
        }
        UserDefaults.standard.set(OpenClawLocationMode.off.rawValue, forKey: defaultsKey)
        let locationService = MockLocationService(authorizationStatus: .authorizedAlways)
        let appModel = NodeAppModel(locationService: locationService)
        var isCurrent = true
        locationService.ensureAuthorizationHandler = { _ in
            isCurrent = false
            return .authorizedAlways
        }

        let granted = await IOSDeviceSettingsActions.applyLocationMode(
            .always,
            appModel: appModel,
            isCurrent: { isCurrent })

        #expect(!granted)
        #expect(UserDefaults.standard.string(forKey: defaultsKey) == OpenClawLocationMode.off.rawValue)
        #expect(locationService.backgroundUpdatesEnabled == nil)
        #expect(locationService.startMonitoringCallCount == 0)
        #expect(locationService.stopMonitoringCallCount == 0)
    }

    @MainActor @Test(arguments: [OpenClawLocationMode.whileUsing, .always], [true, false])
    func `location selection waits for settled authorization and reloads only grants`(
        _ mode: OpenClawLocationMode,
        authorizationGranted: Bool) async throws
    {
        let defaultsKey = "location.enabledMode"
        let previous = UserDefaults.standard.object(forKey: defaultsKey)
        defer {
            if let previous {
                UserDefaults.standard.set(previous, forKey: defaultsKey)
            } else {
                UserDefaults.standard.removeObject(forKey: defaultsKey)
            }
        }
        UserDefaults.standard.set(OpenClawLocationMode.off.rawValue, forKey: defaultsKey)
        let locationService = MockLocationService(authorizationStatus: .notDetermined)
        let requests = AsyncStream<OpenClawLocationMode>.makeStream()
        let responses = AsyncStream<CLAuthorizationStatus>.makeStream()
        defer {
            requests.continuation.finish()
            responses.continuation.finish()
        }
        locationService.ensureAuthorizationHandler = { requestedMode in
            requests.continuation.yield(requestedMode)
            var iterator = responses.stream.makeAsyncIterator()
            return await iterator.next() ?? .denied
        }
        let appModel = NodeAppModel(locationService: locationService, audioAdmissionInitiallyAllowed: false)
        let request = Task { @MainActor in
            await IOSDeviceSettingsActions.applyLocationMode(mode, appModel: appModel)
        }
        var requestedModes = requests.stream.makeAsyncIterator()
        #expect(await requestedModes.next() == mode)
        #expect(UserDefaults.standard.string(forKey: defaultsKey) == OpenClawLocationMode.off.rawValue)
        #expect(locationService.startMonitoringCallCount == 0)

        let authorization: CLAuthorizationStatus = authorizationGranted
            ? (mode == .always ? .authorizedAlways : .authorizedWhenInUse)
            : .denied
        responses.continuation.yield(authorization)
        #expect(await request.value == authorizationGranted)

        let domain = try #require(Bundle.main.bundleIdentifier)
        let reloadedDefaults = UserDefaults()
        let reloadedModel = NodeAppModel(
            locationService: MockLocationService(authorizationStatus: authorization),
            audioAdmissionInitiallyAllowed: false)
        let reloadedSnapshot = IOSDeviceSettingsSnapshotProducer(
            appModel: reloadedModel,
            appearanceModel: AppAppearanceModel(userDefaults: reloadedDefaults),
            defaults: reloadedDefaults).snapshot()
        let expectedMode = authorizationGranted ? mode : .off
        #expect(reloadedDefaults.persistentDomain(forName: domain)?[defaultsKey] as? String == expectedMode.rawValue)
        #expect(reloadedDefaults.string(forKey: defaultsKey) == expectedMode.rawValue)
        #expect(reloadedSnapshot.permissions.location.mode.rawValue == expectedMode.rawValue)
        #expect(locationService.startMonitoringCallCount == (expectedMode == .always ? 1 : 0))
    }

    @MainActor @Test func `external downgrade and always restoration reconcile significant monitoring`() {
        let defaultsKey = "location.enabledMode"
        let previous = UserDefaults.standard.object(forKey: defaultsKey)
        defer {
            if let previous {
                UserDefaults.standard.set(previous, forKey: defaultsKey)
            } else {
                UserDefaults.standard.removeObject(forKey: defaultsKey)
            }
        }
        UserDefaults.standard.set(OpenClawLocationMode.always.rawValue, forKey: defaultsKey)
        let locationService = MockLocationService(authorizationStatus: .authorizedAlways)
        let appModel = NodeAppModel(locationService: locationService)

        withExtendedLifetime(appModel) {
            locationService.simulateAuthorizationChange(.authorizedAlways)
            locationService.simulateAuthorizationChange(.authorizedWhenInUse)
            locationService.simulateAuthorizationChange(.authorizedAlways)
        }

        #expect(locationService.backgroundUpdatesEnabled == true)
        #expect(locationService.startMonitoringCallCount == 2)
        #expect(locationService.stopMonitoringCallCount == 1)
    }

    @MainActor @Test func `node model publishes cached location authorization changes`() {
        let locationService = MockLocationService(
            authorizationStatus: .authorizedWhenInUse,
            accuracyAuthorization: .reducedAccuracy)
        let appModel = NodeAppModel(locationService: locationService)

        #expect(appModel.locationAuthorizationSnapshot == LocationAuthorizationSnapshot(
            authorizationStatus: .authorizedWhenInUse,
            accuracyAuthorization: .reducedAccuracy))

        locationService.simulateAuthorizationChange(
            .authorizedAlways,
            accuracyAuthorization: .fullAccuracy)

        #expect(appModel.locationAuthorizationSnapshot == LocationAuthorizationSnapshot(
            authorizationStatus: .authorizedAlways,
            accuracyAuthorization: .fullAccuracy))
    }
}

@MainActor
private final class MockLocationService: LocationServicing, @unchecked Sendable {
    private var status: CLAuthorizationStatus
    private var accuracy: CLAccuracyAuthorization
    private var authorizationChangeHandler: (@MainActor @Sendable (LocationAuthorizationSnapshot) -> Void)?
    var backgroundUpdatesEnabled: Bool?
    var startMonitoringCallCount = 0
    var stopMonitoringCallCount = 0
    var ensureAuthorizationHandler: (@MainActor (OpenClawLocationMode) async -> CLAuthorizationStatus)?

    init(
        authorizationStatus: CLAuthorizationStatus,
        accuracyAuthorization: CLAccuracyAuthorization = .fullAccuracy)
    {
        self.status = authorizationStatus
        self.accuracy = accuracyAuthorization
    }

    func authorizationStatus() -> CLAuthorizationStatus {
        self.status
    }

    func accuracyAuthorization() -> CLAccuracyAuthorization {
        self.accuracy
    }

    func ensureAuthorization(
        mode: OpenClawLocationMode,
        isCurrent _: @MainActor () -> Bool) async -> CLAuthorizationStatus
    {
        if let ensureAuthorizationHandler {
            self.status = await ensureAuthorizationHandler(mode)
        }
        return self.status
    }

    func currentLocation(
        params: OpenClawLocationGetParams,
        desiredAccuracy: OpenClawLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
    {
        _ = params
        _ = desiredAccuracy
        _ = maxAgeMs
        _ = timeoutMs
        throw LocationService.Error.unavailable
    }

    func setBackgroundLocationUpdatesEnabled(_ enabled: Bool) {
        self.backgroundUpdatesEnabled = enabled
    }

    func setAuthorizationChangeHandler(
        _ handler: @escaping @MainActor @Sendable (LocationAuthorizationSnapshot) -> Void)
    {
        self.authorizationChangeHandler = handler
    }

    func startMonitoringSignificantLocationChanges(onUpdate: @escaping @Sendable (CLLocation) -> Void) {
        _ = onUpdate
        self.startMonitoringCallCount += 1
    }

    func stopMonitoringSignificantLocationChanges() {
        self.stopMonitoringCallCount += 1
    }

    func simulateAuthorizationChange(
        _ status: CLAuthorizationStatus,
        accuracyAuthorization: CLAccuracyAuthorization = .fullAccuracy)
    {
        self.status = status
        self.accuracy = accuracyAuthorization
        self.authorizationChangeHandler?(self.authorizationSnapshot())
    }
}
