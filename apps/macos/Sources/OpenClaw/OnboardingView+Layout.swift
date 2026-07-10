import AppKit
import SwiftUI

extension OnboardingView {
    var body: some View {
        VStack(spacing: 0) {
            // Chat-heavy pages shrink the mascot so the content gets the room.
            GlowingOpenClawIcon(size: self.heroSize)
                .offset(y: self.usesCompactHero ? 4 : 10)
                .frame(height: self.heroFrameHeight)
                .animation(.spring(response: 0.45, dampingFraction: 0.85), value: self.usesCompactHero)

            GeometryReader { _ in
                HStack(spacing: 0) {
                    ForEach(self.pageOrder, id: \.self) { pageIndex in
                        self.pageView(for: pageIndex)
                            .frame(width: self.pageWidth)
                    }
                }
                .offset(x: CGFloat(-self.currentPage) * self.pageWidth)
                .animation(
                    .interactiveSpring(response: 0.5, dampingFraction: 0.86, blendDuration: 0.25),
                    value: self.currentPage)
                .frame(height: self.contentHeight, alignment: .top)
                .clipped()
            }
            .frame(height: self.contentHeight)
            .animation(.spring(response: 0.45, dampingFraction: 0.85), value: self.usesCompactHero)

            Spacer(minLength: 0)
            self.navigationBar
        }
        .frame(width: pageWidth, height: Self.windowHeight)
        .background(Color(NSColor.windowBackgroundColor))
        .onAppear {
            self.onboardingVisible = true
            self.currentPage = 0
            self.updateMonitoring(for: 0)
        }
        .onChange(of: currentPage) { _, newValue in
            self.updateMonitoring(for: self.activePageIndex(for: newValue))
        }
        .onChange(of: state.connectionMode) { _, _ in
            self.handleConnectionModeChange()
        }
        .onChange(of: needsBootstrap) { _, _ in
            if self.currentPage >= self.pageOrder.count {
                self.currentPage = max(0, self.pageOrder.count - 1)
            }
        }
        .onChange(of: cliInstalled) { _, installed in
            guard installed else { return }
            self.updateMonitoring(for: self.activePageIndex)
        }
        .onDisappear {
            self.onboardingVisible = false
            self.stopPermissionMonitoring()
            self.stopDiscovery()
        }
        .task {
            await self.refreshPerms()
            await self.refreshCLIStatus()
            await self.loadWorkspaceDefaults()
            await self.ensureDefaultWorkspace()
            self.refreshBootstrapStatus()
            self.preferredGatewayID = GatewayDiscoveryPreferences.preferredStableID()
        }
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
        self.returnToInferenceSetupIfNeeded()
        if let updatePageMonitoring {
            updatePageMonitoring(self.activePageIndex)
            return
        }
        // A mode swap can keep the same page cursor, so its onChange hook may not restart AI setup.
        self.updateMonitoring(for: self.activePageIndex)
    }

    func resetGatewayBoundAIState() {
        self.aiSetup.resetForGatewayChange()
        // Crestodian sessions belong to one Gateway. Dismiss and replace the chat so
        // changing routes cannot send an old session ID to the new endpoint.
        self.crestodianState.resetForGatewayChange()
    }

    func restartGatewayBoundAISetup(updatePageMonitoring: ((Int) -> Void)? = nil) {
        self.resetGatewayBoundAIState()
        self.returnToInferenceSetupIfNeeded()
        if let updatePageMonitoring {
            updatePageMonitoring(self.activePageIndex)
            return
        }
        // A route edit can leave the page cursor unchanged, so explicitly restart its work.
        self.updateMonitoring(for: self.activePageIndex)
    }

    private func returnToInferenceSetupIfNeeded() {
        let targetPage = Self.pageCursorAfterGatewayReset(
            currentPage: self.currentPage,
            pageOrder: self.pageOrder,
            aiPageIndex: self.aiPageIndex)
        guard targetPage != self.currentPage else { return }
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

    func onboardingPage(@ViewBuilder _ content: () -> some View) -> some View {
        let scrollIndicatorGutter: CGFloat = 18
        return ScrollView {
            VStack(spacing: 16) {
                content()
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .top)
            .padding(.trailing, scrollIndicatorGutter)
        }
        .scrollIndicators(.automatic)
        .padding(.horizontal, 28)
        .frame(width: pageWidth, alignment: .top)
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

    func onboardingGlassCard(
        spacing: CGFloat = 12,
        padding: CGFloat = 16,
        @ViewBuilder _ content: () -> some View) -> some View
    {
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        return VStack(alignment: .leading, spacing: spacing) {
            content()
        }
        .padding(padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.clear)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
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
