import AppKit
import SwiftUI

extension OnboardingView {
    /// The inference-first flow has no full-page chat; Crestodian opens in its own sheet.
    var usesCompactHero: Bool {
        false
    }

    var body: some View {
        GeometryReader { windowGeometry in
            let contentHeight = self.contentHeight(for: windowGeometry.size.height)
            VStack(spacing: 0) {
                // Chat-heavy pages shrink the mascot so the content gets the room.
                GlowingOpenClawIcon(size: self.heroSize, mood: self.mascotMood)
                    .offset(y: self.usesCompactHero ? 4 : 10)
                    .frame(height: self.heroFrameHeight)
                    .animation(.spring(response: 0.45, dampingFraction: 0.85), value: self.usesCompactHero)

                GeometryReader { _ in
                    HStack(spacing: 0) {
                        ForEach(self.pageOrder, id: \.self) { pageIndex in
                            self.pageView(for: pageIndex, contentHeight: contentHeight)
                                .frame(width: self.pageWidth)
                        }
                    }
                    .offset(x: CGFloat(-self.currentPage) * self.pageWidth)
                    .animation(
                        .interactiveSpring(response: 0.5, dampingFraction: 0.86, blendDuration: 0.25),
                        value: self.currentPage)
                    .frame(height: contentHeight, alignment: .top)
                    .clipped()
                }
                .frame(height: contentHeight)
                .animation(.spring(response: 0.45, dampingFraction: 0.85), value: self.usesCompactHero)

                Spacer(minLength: 0)
                self.navigationBar
            }
            .frame(maxHeight: .infinity)
        }
        .frame(
            minWidth: pageWidth,
            maxWidth: pageWidth,
            minHeight: Self.windowHeight,
            maxHeight: .infinity)
        .background(Color(NSColor.windowBackgroundColor))
        .onAppear {
            self.onboardingDidAppear()
        }
        .onChange(of: currentPage) { _, newValue in
            self.updateMonitoring(for: self.activePageIndex(for: newValue))
        }
        .onChange(of: state.connectionMode) { _, _ in
            self.handleConnectionModeChange()
        }
        .onChange(of: cliInstalled) { _, installed in
            guard installed else { return }
            self.updateMonitoring(for: self.activePageIndex)
        }
        .onDisappear {
            self.onboardingDidDisappear()
        }
        .task {
            await self.refreshPerms()
            await self.refreshCLIStatus()
            self.preferredGatewayID = GatewayDiscoveryPreferences.preferredStableID()
        }
        .task {
            await self.configuredGatewayProbe.consumeReconnects {
                self.probeConfiguredGatewayForDashboard(
                    startAISetupWhenMissing: self.activePageIndex == self.aiPageIndex)
            }
        }
    }

    @discardableResult
    func onboardingDidAppear() -> Task<Void, Never>? {
        onboardingVisible = true
        currentPage = 0
        updateMonitoring(for: 0)
        // App launch may have connected and emitted its snapshot before this
        // view subscribed. Always inspect the selected route once on appear.
        return self.probeConfiguredGatewayForDashboard(knownVisible: true)
    }

    func onboardingDidDisappear() {
        onboardingVisible = false
        configuredGatewayProbe.invalidate()
        // Queued detection can otherwise proceed into a mutating activation
        // after the window or its selected route has gone away.
        aiSetup.resetForGatewayChange(clearPendingHandoff: false)
        crestodianState.resetForGatewayChange()
        stopPermissionMonitoring()
        stopDiscovery()
    }

    func activePageIndex(for pageCursor: Int) -> Int {
        guard !pageOrder.isEmpty else { return 0 }
        let clamped = min(max(0, pageCursor), pageOrder.count - 1)
        return pageOrder[clamped]
    }

    func reconcilePageForModeChange(previousActivePageIndex: Int) {
        if let exact = pageOrder.firstIndex(of: previousActivePageIndex) {
            withAnimation { self.currentPage = exact }
            return
        }
        if let next = pageOrder.firstIndex(where: { $0 > previousActivePageIndex }) {
            withAnimation { self.currentPage = next }
            return
        }
        withAnimation { self.currentPage = max(0, self.pageOrder.count - 1) }
    }

    func handleConnectionModeChange(updatePageMonitoring: ((Int) -> Void)? = nil) {
        self.resetGatewayBoundAIState()
        let oldActive = self.activePageIndex
        self.reconcilePageForModeChange(previousActivePageIndex: oldActive)
        self.startExistingCLIActivationIfNeeded()
        self.returnToInferenceSetupIfNeeded()
        if let updatePageMonitoring {
            updatePageMonitoring(self.activePageIndex)
            self.probeConfiguredGatewayForDashboard(
                startAISetupWhenMissing: self.activePageIndex == aiPageIndex)
            return
        }
        // A mode swap can keep the same page cursor, so its onChange hook may not restart AI setup.
        updateMonitoring(for: self.activePageIndex)
        self.probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: self.activePageIndex == aiPageIndex)
    }

    func resetGatewayBoundAIState() {
        configuredGatewayProbe.invalidate()
        // The UI attempt belongs to one route, but its durable activation lease
        // must survive A -> B -> A while the old Gateway can still be mutating.
        aiSetup.resetForGatewayChange(clearPendingHandoff: false)
        // Crestodian sessions belong to one Gateway. Dismiss and replace the chat so
        // changing routes cannot send an old session ID to the new endpoint.
        crestodianState.resetForGatewayChange()
    }

    @discardableResult
    func probeConfiguredGatewayForDashboard(
        startAISetupWhenMissing: Bool = false,
        knownVisible: Bool = false,
        knownAISetupPage: Bool = false) -> Task<Void, Never>?
    {
        // onAppear itself is authoritative even before SwiftUI commits the
        // @State write; probe invalidation still rejects post-disappear results.
        guard knownVisible || onboardingVisible else { return nil }
        // `Check connection` temporarily borrows remote mode without selecting
        // that Gateway. Its successful handshake must never complete onboarding.
        guard !configuredGatewayProbe.isSuppressedForTemporaryConnectionCheck else { return nil }
        // Persist the latest selection before GatewayEndpointStore resolves the
        // route, so an immediate probe cannot attach to the previous endpoint.
        guard gatewaySelectionPersister() else { return nil }
        let expectedMode = state.connectionMode
        let expectedRouteIdentity = self.aiSetupRouteIdentityProvider()
        let expectedPendingState = OnboardingCrestodianResumeStore.pendingState(
            for: expectedRouteIdentity,
            defaults: crestodianDefaults)
        let expectedActivationOwner = OnboardingCrestodianResumeStore.activationOwner(
            for: expectedRouteIdentity,
            defaults: crestodianDefaults)
        let probeAttempt = configuredGatewayProbe.beginProbe()
        return Task { @MainActor in
            let outcome = await self.configuredGatewayProbe.probe(
                connectionMode: expectedMode,
                attempt: probeAttempt,
                routeIdentity: expectedRouteIdentity)
            guard await self.isCurrentConfiguredGatewayProbeOutcome(
                outcome,
                attempt: probeAttempt,
                expectedMode: expectedMode,
                expectedRouteIdentity: expectedRouteIdentity,
                knownVisible: knownVisible)
            else { return }
            let pendingState = OnboardingCrestodianResumeStore.pendingState(
                for: expectedRouteIdentity,
                defaults: self.crestodianDefaults)
            let crestodianResumePending = pendingState != .none
            self.schedulePendingActivationRecheckIfNeeded(pendingState)

            switch outcome {
            case let .configured(modelRef, _):
                switch pendingState {
                case .activating, .activationExpired, .completed:
                    // A live setup/verification already owns this marker. A
                    // reconnect must not downgrade connected state or fork a
                    // second resume operation.
                    guard !self.aiSetup.connected else { return }
                    self.resumePendingCrestodian(modelRef: modelRef)
                    return
                case .verified:
                    // Inference was observed, but the dropped activation can
                    // still be mutating until the same durable deadline.
                    self.waitForPendingInferenceSetup()
                    return
                case .none:
                    // A concurrent probe can clear an expired marker while
                    // the dispatched activation is still returning. Keep the
                    // setup-owned handoff, and prove inference on this route.
                    if self.aiSetup.pendingActivationVerification {
                        self.resumePendingCrestodian(modelRef: modelRef)
                        return
                    }
                }
                guard Self.shouldOpenConfiguredGatewayDashboard(
                    onboardingVisible: self.onboardingVisible,
                    expectedMode: expectedMode,
                    currentMode: self.state.connectionMode,
                    crestodianResumePending: crestodianResumePending,
                    setupOwnsInferenceTransition: self.aiSetup.ownsInferenceTransition)
                else { return }
                self.onboardingVisible = false
                self.configuredGatewayProbe.invalidate()
                OnboardingController.markComplete()
                OnboardingController.shared.close()
                AppNavigationActions.openDashboard()
            case .missing:
                // A route-bound activation/verification can complete while the
                // earlier agents.list request is suspended. Never let that
                // stale absence reset connected inference or its handoff marker.
                guard !self.aiSetup.connected else { return }
                switch pendingState {
                case .activating, .verified:
                    // A dropped activation may still be committing. Keep this
                    // route read-only until its durable maximum deadline.
                    self.waitForPendingInferenceSetup()
                    return
                case .activationExpired, .completed:
                    // The absence result was dispatched for the receipt visible
                    // at probe start. A replacement attempt owns its own retry.
                    guard expectedPendingState != .none,
                          let expectedRouteIdentity,
                          OnboardingCrestodianResumeStore.clear(
                              ifOwnedBy: expectedRouteIdentity,
                              activationOwner: expectedActivationOwner,
                              defaults: self.crestodianDefaults)
                    else { return }
                    self.resumePendingInferenceSetup()
                    return
                case .none:
                    break
                }
                if startAISetupWhenMissing,
                   knownAISetupPage || self.activePageIndex == self.aiPageIndex
                {
                    self.aiSetup.startIfNeeded()
                }
            case .unavailable:
                // Transport/protocol failure is not evidence that inference is
                // absent. Preserve every lease and wait for reconnect/retry.
                self.aiSetup.showConfiguredGatewayProbeUnavailable()
            case .superseded:
                break
            }
        }
    }

    private func isCurrentConfiguredGatewayProbeOutcome(
        _ outcome: OnboardingConfiguredGatewayProbe.Outcome,
        attempt: OnboardingConfiguredGatewayProbe.Attempt,
        expectedMode: AppState.ConnectionMode,
        expectedRouteIdentity: String?,
        knownVisible: Bool) async -> Bool
    {
        if let boundRoute = outcome.boundRoute {
            guard boundRoute.identity == expectedRouteIdentity,
                  await self.configuredGatewayProbe.isCurrent(boundRoute)
            else { return false }
        }
        let currentRouteIdentity = self.aiSetupRouteIdentityProvider()
        return self.configuredGatewayProbe.isCurrent(attempt) &&
            Self.isCurrentConfiguredGatewayProbe(
                onboardingVisible: knownVisible || self.onboardingVisible,
                expectedMode: expectedMode,
                currentMode: self.state.connectionMode) &&
            currentRouteIdentity == expectedRouteIdentity
    }

    private func schedulePendingActivationRecheckIfNeeded(
        _ pendingState: OnboardingCrestodianResumeStore.PendingState)
    {
        switch pendingState {
        case let .activating(deadline), let .verified(deadline):
            self.configuredGatewayProbe.schedulePendingActivationRecheck(deadline: deadline) {
                self.probeConfiguredGatewayForDashboard(startAISetupWhenMissing: true)
            }
        case .activationExpired, .completed, .none:
            break
        }
    }

    static func shouldOpenConfiguredGatewayDashboard(
        onboardingVisible: Bool,
        expectedMode: AppState.ConnectionMode,
        currentMode: AppState.ConnectionMode,
        crestodianResumePending: Bool,
        setupOwnsInferenceTransition: Bool) -> Bool
    {
        self.isCurrentConfiguredGatewayProbe(
            onboardingVisible: onboardingVisible,
            expectedMode: expectedMode,
            currentMode: currentMode) &&
            !crestodianResumePending &&
            !setupOwnsInferenceTransition
    }

    static func isCurrentConfiguredGatewayProbe(
        onboardingVisible: Bool,
        expectedMode: AppState.ConnectionMode,
        currentMode: AppState.ConnectionMode) -> Bool
    {
        onboardingVisible &&
            expectedMode != .unconfigured &&
            expectedMode == currentMode
    }

    private func returnToInferenceSetupIfNeeded() {
        let targetPage = Self.pageCursorAfterGatewayReset(
            currentPage: currentPage,
            pageOrder: pageOrder,
            aiPageIndex: aiPageIndex)
        guard targetPage != currentPage else { return }
        withAnimation { self.currentPage = targetPage }
    }

    static func pageCursorAfterGatewayReset(
        currentPage: Int,
        pageOrder: [Int],
        aiPageIndex: Int) -> Int
    {
        guard let aiPageCursor = pageOrder.firstIndex(of: aiPageIndex),
              currentPage >= aiPageCursor
        else {
            return currentPage
        }
        return aiPageCursor
    }

    var navigationBar: some View {
        let connectionLockIndex = pageOrder.firstIndex(of: connectionPageIndex)
        let cliLockIndex = pageOrder.firstIndex(of: cliPageIndex)
        let aiLockIndex = pageOrder.firstIndex(of: aiPageIndex)
        return HStack(spacing: 20) {
            ZStack(alignment: .leading) {
                Button(action: {}, label: {
                    Label("Back", systemImage: "chevron.left").labelStyle(.iconOnly)
                })
                .buttonStyle(.plain)
                .opacity(0)
                .disabled(true)

                if self.currentPage > 0 {
                    Button(action: self.handleBack, label: {
                        Label("Back", systemImage: "chevron.left")
                            .labelStyle(.iconOnly)
                    })
                    .buttonStyle(.plain)
                    .foregroundColor(.secondary)
                    .opacity(0.8)
                    .disabled(self.installingCLI || self.aiSetup.isBusy)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
            }
            .frame(minWidth: 80, alignment: .leading)

            Spacer()

            HStack(spacing: 8) {
                ForEach(0..<self.pageCount, id: \.self) { index in
                    let isInstallLocked = (self.installingCLI || self.aiSetup.isBusy) &&
                        index != self.currentPage
                    let isConnectionLocked = self.isConnectionSelectionBlocking &&
                        index > (connectionLockIndex ?? 0)
                    let isCLILocked = cliLockIndex != nil && !self.cliInstalled && index > (cliLockIndex ?? 0)
                    // Dots must honor the same setup gate as Next: no jumping
                    // past the AI page before a candidate passed its live test.
                    let isAILocked = aiLockIndex != nil &&
                        self.state.connectionMode != .unconfigured &&
                        !self.aiSetup.connected &&
                        index > (aiLockIndex ?? 0)
                    let isLocked = isInstallLocked || isConnectionLocked || isCLILocked ||
                        isAILocked
                    Button {
                        withAnimation { self.currentPage = index }
                    } label: {
                        Circle()
                            .fill(index == self.currentPage ? Color.accentColor : Color.gray.opacity(0.3))
                            .frame(width: 8, height: 8)
                    }
                    .buttonStyle(.plain)
                    .disabled(isLocked)
                    .opacity(isLocked ? 0.3 : 1)
                }
            }

            Spacer()

            Button(action: self.handleNext) {
                Text(self.buttonTitle)
                    .frame(minWidth: 88)
            }
            .keyboardShortcut(.return)
            .buttonStyle(.borderedProminent)
            .disabled(!self.canAdvance)
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 13)
        .frame(minHeight: 60, alignment: .bottom)
    }

    func onboardingPage(@ViewBuilder _ content: @escaping () -> some View) -> some View {
        let scrollIndicatorGutter: CGFloat = 18
        return GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 16) {
                    content()
                }
                .frame(maxWidth: .infinity)
                .frame(minHeight: geometry.size.height, alignment: .center)
                .padding(.trailing, scrollIndicatorGutter)
            }
            .scrollIndicators(.automatic)
            .padding(.horizontal, 28)
            .frame(width: pageWidth, alignment: .top)
        }
    }

    func onboardingCard(
        spacing: CGFloat = 12,
        padding: CGFloat = 16,
        @ViewBuilder _ content: () -> some View) -> some View
    {
        VStack(alignment: .leading, spacing: spacing) {
            content()
        }
        .padding(padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(NSColor.controlBackgroundColor))
                .shadow(color: .black.opacity(0.06), radius: 8, y: 3))
    }

    func featureRow(title: String, subtitle: String, systemImage: String) -> some View {
        self.featureRowContent(title: title, subtitle: subtitle, systemImage: systemImage)
    }

    func featureActionRow(
        title: String,
        subtitle: String,
        systemImage: String,
        buttonTitle: String,
        action: @escaping () -> Void) -> some View
    {
        self.featureRowContent(
            title: title,
            subtitle: subtitle,
            systemImage: systemImage,
            action: AnyView(
                Button(buttonTitle, action: action)
                    .buttonStyle(.link)
                    .padding(.top, 2)))
    }

    private func featureRowContent(
        title: String,
        subtitle: String,
        systemImage: String,
        action: AnyView? = nil) -> some View
    {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let action {
                    action
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }
}
