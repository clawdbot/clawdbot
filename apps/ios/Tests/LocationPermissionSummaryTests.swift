import CoreLocation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.serialized) struct LocationPermissionSummaryTests {
    @Test func `location settings presentation uses apple access labels`() {
        let whileUsing = LocationSettingsPresentation(
            selectedMode: .whileUsing,
            summary: LocationPermissionSummary(
                desiredMode: .whileUsing,
                locationServicesEnabled: true,
                authorizationStatus: .authorizedWhenInUse,
                accuracyAuthorization: .fullAccuracy))
        let always = LocationSettingsPresentation(
            selectedMode: .always,
            summary: LocationPermissionSummary(
                desiredMode: .always,
                locationServicesEnabled: true,
                authorizationStatus: .authorizedAlways,
                accuracyAuthorization: .fullAccuracy))
        let whileUsingWithAlwaysGrant = LocationSettingsPresentation(
            selectedMode: .whileUsing,
            summary: LocationPermissionSummary(
                desiredMode: .whileUsing,
                locationServicesEnabled: true,
                authorizationStatus: .authorizedAlways,
                accuracyAuthorization: .fullAccuracy))

        #expect(whileUsing.accessLevelText == "While Using the App")
        #expect(always.accessLevelText == "Always")
        #expect(whileUsingWithAlwaysGrant.accessLevelText == "While Using the App")
        #expect(OpenClawLocationMode.off.locationAccessLevelText == nil)
    }

    @Test func `location sharing control follows selected mode while permission is pending`() {
        let presentation = LocationSettingsPresentation(
            selectedMode: .whileUsing,
            summary: LocationPermissionSummary(
                desiredMode: .whileUsing,
                locationServicesEnabled: true,
                authorizationStatus: .notDetermined,
                accuracyAuthorization: .fullAccuracy))

        #expect(presentation.sharingControlIsOn)
        #expect(presentation.showsAccessLevel)
        #expect(presentation.accessLevelText == "While Using the App")
        #expect(presentation.statusText == "iOS permission is required to share location.")
        #expect(presentation.toggleAction() == .setMode(.off))
    }

    @Test func `location sharing toggle from off requests while using by default`() {
        let presentation = LocationSettingsPresentation(
            selectedMode: .off,
            summary: LocationPermissionSummary(
                desiredMode: .off,
                locationServicesEnabled: true,
                authorizationStatus: .notDetermined,
                accuracyAuthorization: .fullAccuracy))

        #expect(!presentation.sharingControlIsOn)
        #expect(!presentation.showsAccessLevel)
        #expect(presentation.toggleAction() == .setMode(.whileUsing))
    }

    @Test func `access level stays hidden when sharing is off despite retained ios grant`() {
        let presentation = LocationSettingsPresentation(
            selectedMode: .off,
            summary: LocationPermissionSummary(
                desiredMode: .off,
                locationServicesEnabled: true,
                authorizationStatus: .authorizedAlways,
                accuracyAuthorization: .fullAccuracy))

        #expect(!presentation.sharingControlIsOn)
        #expect(!presentation.showsAccessLevel)
        #expect(presentation.accessLevelText == nil)
    }

    @Test func `location sharing toggle opens app settings when denied`() {
        let presentation = LocationSettingsPresentation(
            selectedMode: .off,
            summary: LocationPermissionSummary(
                desiredMode: .off,
                locationServicesEnabled: true,
                authorizationStatus: .denied,
                accuracyAuthorization: .fullAccuracy))

        #expect(!presentation.sharingControlIsOn)
        #expect(!presentation.showsAccessLevel)
        #expect(presentation.accessLevelText == nil)
        #expect(presentation.statusText == nil)
        #expect(presentation.toggleAction() == .openAppSettings(.whileUsing))
    }

    @Test func `access level reports selection and warns when ios grant is lower`() {
        let presentation = LocationSettingsPresentation(
            selectedMode: .always,
            summary: LocationPermissionSummary(
                desiredMode: .always,
                locationServicesEnabled: true,
                authorizationStatus: .authorizedWhenInUse,
                accuracyAuthorization: .fullAccuracy))

        #expect(presentation.sharingControlIsOn)
        #expect(presentation.showsAccessLevel)
        #expect(presentation.accessLevelText == "Always")
        #expect(presentation.statusText == "iOS currently allows location only while using the app.")
        #expect(presentation.accessLevelAction(mode: .always) == .setMode(.always))
        #expect(presentation.accessLevelAction(mode: .whileUsing) == .setMode(.whileUsing))
        #expect(presentation.toggleAction() == .setMode(.off))
    }

    @Test func `healthy location sharing hides redundant status copy`() {
        let presentation = LocationSettingsPresentation(
            selectedMode: .whileUsing,
            summary: LocationPermissionSummary(
                desiredMode: .whileUsing,
                locationServicesEnabled: true,
                authorizationStatus: .authorizedWhenInUse,
                accuracyAuthorization: .fullAccuracy))

        #expect(presentation.sharingControlIsOn)
        #expect(presentation.statusText == nil)
    }

    @Test func `global location services off opens app settings action`() {
        let presentation = LocationSettingsPresentation(
            selectedMode: .off,
            summary: LocationPermissionSummary(
                desiredMode: .off,
                locationServicesEnabled: false,
                authorizationStatus: .authorizedWhenInUse,
                accuracyAuthorization: .fullAccuracy))

        #expect(!presentation.sharingControlIsOn)
        #expect(!presentation.showsAccessLevel)
        #expect(presentation.statusText == nil)
        #expect(presentation.toggleAction() == .openAppSettings(.whileUsing))
    }

    @Test func `restricted location permission shows settings guidance`() {
        let presentation = LocationSettingsPresentation(
            selectedMode: .whileUsing,
            summary: LocationPermissionSummary(
                desiredMode: .whileUsing,
                locationServicesEnabled: true,
                authorizationStatus: .restricted,
                accuracyAuthorization: .fullAccuracy))

        #expect(presentation.sharingControlIsOn)
        #expect(presentation.showsAccessLevel)
        #expect(presentation.statusText == "Location permission is restricted on this device.")
        #expect(presentation.toggleAction() == .setMode(.off))
        #expect(presentation.accessLevelAction(mode: .whileUsing) == .openAppSettings(.whileUsing))
    }

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

    @MainActor @Test(arguments: [CLAuthorizationStatus.notDetermined, .denied], [false, true])
    func `location authorization refreshes registration without settings`(
        initialStatus: CLAuthorizationStatus,
        authorizationBeforeRegistration: Bool) async throws
    {
        let isolation = GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        try await withUserDefaults(["location.enabledMode": "whileUsing", "gateway.autoconnect": false]) {
            let locationService = MockLocationService(authorizationStatus: initialStatus)
            let appModel = NodeAppModel(locationService: locationService)
            defer { appModel.disconnectGateway() }
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
            let options = await controller.makeConnectOptions(
                stableID: "manual|127.0.0.1|1",
                deviceAuthGatewayID: nil,
                allowStoredDeviceAuth: false)
            let config = try GatewayConnectConfig(
                url: #require(URL(string: "ws://127.0.0.1:1")),
                stableID: "manual|127.0.0.1|1",
                tls: nil,
                token: nil,
                bootstrapToken: nil,
                password: nil,
                nodeOptions: options)
            if authorizationBeforeRegistration {
                // Startup and target-review resume can apply options captured before an asynchronous reset.
                locationService.simulateAuthorizationChange(.authorizedWhenInUse)
                _ = await controller.makeConnectOptions(stableID: config.stableID, deviceAuthGatewayID: nil)
                #expect(appModel.activeGatewayConnectConfig == nil)
            }
            appModel.applyGatewayConnectConfig(config)
            #expect(appModel.activeGatewayConnectConfig?.nodeOptions.permissions["location"] == false)

            // The system callback must refresh the advertised permission even when no Settings view exists.
            if !authorizationBeforeRegistration {
                locationService.simulateAuthorizationChange(.authorizedWhenInUse)
            }
            let granted = await Self.waitForLocationRegistration(true, appModel: appModel)
            try #require(granted)
            #expect(appModel.activeGatewayConnectConfig?.stableID == config.stableID)
            #expect(appModel.activeGatewayConnectConfig?.nodeOptions.allowStoredDeviceAuth == false)

            locationService.simulateAuthorizationChange(.denied)
            #expect(await Self.waitForLocationRegistration(false, appModel: appModel))
            appModel.suspendGatewayForTargetReview()
            locationService.simulateAuthorizationChange(.authorizedAlways)
            await appModel.waitForGatewaySessionResetIfNeeded()
            _ = await controller.makeConnectOptions(stableID: config.stableID, deviceAuthGatewayID: nil)
            #expect(appModel.activeGatewayConnectConfig == nil)
            #expect(!appModel.gatewayAutoReconnectEnabled)
            withExtendedLifetime(controller) {}
        }
    }

    @MainActor @Test(arguments: [false, true])
    func `authorization change waits for forced reset ownership before restoring registration`(
        supersedingHandoff: Bool) async throws
    {
        let isolation = GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        try await withUserDefaults(["location.enabledMode": "whileUsing", "gateway.autoconnect": false]) {
            let replacementHost = "replacement.gateway.invalid"
            let replacementID = "manual|\(replacementHost)|443"
            let supersedingHost = "superseding.gateway.invalid"
            let supersedingID = "manual|\(supersedingHost)|443"
            GatewayTLSStore.saveFingerprint("replacement-fingerprint", stableID: replacementID)
            GatewayTLSStore.saveFingerprint("superseding-fingerprint", stableID: supersedingID)
            defer {
                GatewayTLSStore.clearFingerprint(stableID: replacementID)
                GatewayTLSStore.clearFingerprint(stableID: supersedingID)
            }
            let resetFinished = AsyncStream<Void>.makeStream()
            let resetRelease = AsyncStream<Void>.makeStream()
            let supersedingResetRelease = AsyncStream<Void>.makeStream()
            defer {
                resetRelease.continuation.finish()
                supersedingResetRelease.continuation.finish()
                resetFinished.continuation.finish()
            }
            let locationService = MockLocationService(authorizationStatus: .denied)
            let appModel = NodeAppModel(locationService: locationService)
            defer { appModel.disconnectGateway() }
            var resetCount = 0
            let controller = GatewayConnectionController(
                appModel: appModel,
                startDiscovery: false,
                forceReconnectReset: { appModel in
                    await appModel.resetGatewaySessionsForForcedReconnect()
                    resetCount += 1
                    let release = resetCount == 1 ? resetRelease.stream : supersedingResetRelease.stream
                    resetFinished.continuation.yield()
                    for await _ in release {
                        return
                    }
                })
            let currentID = "manual|127.0.0.1|1"
            let options = await controller.makeConnectOptions(
                stableID: currentID,
                deviceAuthGatewayID: currentID,
                allowStoredDeviceAuth: false)
            let config = try GatewayConnectConfig(
                url: #require(URL(string: "ws://127.0.0.1:1")),
                stableID: currentID,
                tls: nil,
                token: nil,
                bootstrapToken: nil,
                password: nil,
                nodeOptions: options)
            appModel.applyGatewayConnectConfig(config)
            var finishedIterator = resetFinished.stream.makeAsyncIterator()
            await controller.connectManual(host: replacementHost, port: 443, useTLS: true, forceReconnect: true)
            _ = await finishedIterator.next()

            locationService.simulateAuthorizationChange(.authorizedWhenInUse)
            // Hold the handoff beyond the registration deadline: a grant must not recover its stopped loops.
            #expect(await Self.waitForLocationRegistration(true, appModel: appModel) == false)
            #expect(!appModel._test_hasGatewayLoopTasks().node)
            #expect(!appModel._test_hasGatewayLoopTasks().operator)

            if supersedingHandoff {
                await controller.connectManual(host: supersedingHost, port: 443, useTLS: true, forceReconnect: true)
                resetRelease.continuation.yield()
                resetRelease.continuation.finish()
                _ = await finishedIterator.next()
                // Completing the captured handoff must not bypass the replacement's reset ownership.
                #expect(await Self.waitForLocationRegistration(true, appModel: appModel) == false)
                #expect(!appModel._test_hasGatewayLoopTasks().node)
                #expect(!appModel._test_hasGatewayLoopTasks().operator)
            }

            let cancellation = controller.cancelPendingConnectionAttempts()
            resetRelease.continuation.yield()
            resetRelease.continuation.finish()
            supersedingResetRelease.continuation.yield()
            supersedingResetRelease.continuation.finish()
            #expect(await Self.waitForLocationRegistration(true, appModel: appModel))
            #expect(appModel.activeGatewayConnectConfig?.stableID == currentID)
            #expect(appModel.activeGatewayConnectConfig?.url == config.url)
            #expect(appModel.activeGatewayConnectConfig?.nodeOptions.deviceAuthGatewayID == currentID)
            #expect(appModel.activeGatewayConnectConfig?.nodeOptions.allowStoredDeviceAuth == false)
            #expect(appModel._test_hasGatewayLoopTasks().node)
            controller.releaseAutoConnectSuppression(after: cancellation)
            appModel.disconnectGateway()
            await appModel.waitForGatewaySessionResetIfNeeded()
            withExtendedLifetime(controller) {}
        }
    }

    @MainActor @Test func `connect generation reconciles authorization when the route remains unchanged`() async throws {
        let isolation = GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        try await withUserDefaults(["location.enabledMode": "whileUsing", "gateway.autoconnect": false]) {
            let locationService = MockLocationService(authorizationStatus: .denied)
            let appModel = NodeAppModel(locationService: locationService)
            defer { appModel.disconnectGateway() }
            let stableID = "manual|127.0.0.1|1"
            var sourceController: GatewayConnectionController? = GatewayConnectionController(
                appModel: appModel,
                startDiscovery: false)
            weak var sourceLifetime = sourceController
            let options = try await #require(sourceController).makeConnectOptions(
                stableID: stableID,
                deviceAuthGatewayID: stableID,
                allowStoredDeviceAuth: false)
            sourceController = nil
            #expect(sourceLifetime == nil)
            let config = try GatewayConnectConfig(
                url: #require(URL(string: "ws://127.0.0.1:1")),
                stableID: stableID,
                tls: nil,
                token: nil,
                bootstrapToken: nil,
                password: nil,
                nodeOptions: options)
            // Model a grant whose previous refresh was invalidated: neither its callback nor a route change remains.
            locationService.simulateAuthorizationChange(.authorizedWhenInUse)
            appModel.applyGatewayConnectConfig(config)
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
            #expect(appModel.activeGatewayConnectConfig?.hasSameConnectionInputs(as: config) == true)

            let generation = appModel.beginGatewayConnectAttempt()
            #expect(await Self.waitForLocationRegistration(true, appModel: appModel))
            let refreshed = try #require(appModel.activeGatewayConnectConfig)
            #expect(refreshed.stableID == config.stableID)
            #expect(refreshed.url == config.url)
            #expect(refreshed.tls == nil)
            #expect(refreshed.token == config.token)
            #expect(refreshed.bootstrapToken == config.bootstrapToken)
            #expect(refreshed.password == config.password)
            #expect(refreshed.nodeOptions.deviceAuthGatewayID == stableID)
            #expect(refreshed.nodeOptions.allowStoredDeviceAuth == false)
            #expect(appModel.gatewayConnectGeneration == generation)
            appModel.disconnectGateway()
            await appModel.waitForGatewaySessionResetIfNeeded()
            withExtendedLifetime(controller) {}
        }
    }

    @MainActor
    private static func waitForLocationRegistration(_ granted: Bool, appModel: NodeAppModel) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while appModel.activeGatewayConnectConfig?.nodeOptions.permissions["location"] != granted,
              ContinuousClock.now < deadline
        {
            // Yield alone need not let lower-priority permission sampling make progress.
            try? await Task.sleep(for: .milliseconds(10))
        }
        return appModel.activeGatewayConnectConfig?.nodeOptions.permissions["location"] == granted
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
final class MockLocationService: LocationServicing, @unchecked Sendable {
    private var status: CLAuthorizationStatus
    private var accuracy: CLAccuracyAuthorization
    private var authorizationChangeHandler: (@MainActor @Sendable (LocationAuthorizationSnapshot) -> Void)?
    var backgroundUpdatesEnabled: Bool?
    var startMonitoringCallCount = 0
    var stopMonitoringCallCount = 0

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

    func ensureAuthorization(mode: OpenClawLocationMode) async -> CLAuthorizationStatus {
        _ = mode
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
