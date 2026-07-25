import SwiftUI

extension OnboardingView {
    func memoryImportPage(contentHeight: CGFloat) -> some View {
        VStack(spacing: 12) {
            Text("Bring your memories along")
                .font(.largeTitle.weight(.semibold))
            Text("OpenClaw can bring useful context from AI tools you already use into your new assistant.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 540)
                .fixedSize(horizontal: false, vertical: true)

            ScrollView {
                self.memoryImportContent
                    .padding(.vertical, 4)
                    .padding(.trailing, 12)
            }
            .scrollIndicators(.automatic)
        }
        .padding(.horizontal, 28)
        .padding(.top, 48)
        .frame(width: self.pageWidth, height: contentHeight, alignment: .top)
    }

    @ViewBuilder
    private var memoryImportContent: some View {
        switch self.memoryImport.phase {
        case .idle, .planning:
            self.memoryImportProgress(
                title: "Looking for memories…",
                detail: "Checking supported AI tools on this Mac.")
        case .offer:
            self.memoryImportOffer(applying: false)
        case .empty:
            self.memoryImportProgress(
                title: "No memories to import",
                detail: "You can import memories later from the dashboard.")
        case let .failed(message):
            self.memoryImportFailure(message: message)
        case .applying:
            self.memoryImportOffer(applying: true)
        case let .done(results):
            self.memoryImportResults(results)
        }
    }

    private func memoryImportOffer(applying: Bool) -> some View {
        VStack(spacing: 14) {
            self.onboardingCard(spacing: 0, padding: 0) {
                ForEach(Array(self.memoryImport.providers.enumerated()), id: \.element.id) { index, provider in
                    if index > 0 { Divider() }
                    self.memoryImportProviderRow(provider)
                        .padding(14)
                }
            }

            Button {
                Task { await self.memoryImport.importSelected(gateway: self.memoryImportGateway) }
            } label: {
                HStack(spacing: 8) {
                    if applying {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Text(applying ? "Importing memories…" : "Import memories")
                }
                .frame(minWidth: 150)
            }
            .buttonStyle(.borderedProminent)
            .disabled(applying || !self.memoryImport.hasSelectedProviders)

            if !applying, self.memoryImport.hasReplanRequired {
                Button("Refresh plan") {
                    Task { await self.memoryImport.startPlanning(gateway: self.memoryImportGateway) }
                }
                .buttonStyle(.bordered)
                .disabled(!self.memoryImport.canReplan)
                if !self.memoryImport.canReplan {
                    Text("Retry pending imports before refreshing the plan.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            Text("You can skip this and import later from the dashboard’s Memory import page.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: 520)
    }

    private func memoryImportProviderRow(_ provider: OnboardingMemoryImportModel.Provider) -> some View {
        Toggle(isOn: Binding(
            get: { self.memoryImport.providers.first(where: { $0.id == provider.id })?.selected ?? false },
            set: { self.memoryImport.setSelected($0, providerId: provider.providerId) }))
        {
            VStack(alignment: .leading, spacing: 4) {
                Text(provider.label)
                    .font(.headline)
                Text(
                    "\(provider.plannedCount) \(self.memoryLabel(provider.plannedCount)) · " +
                        (provider.source ?? "local files"))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if provider.alreadyImportedCount > 0 {
                    Text("\(provider.alreadyImportedCount) already imported")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let result = provider.result {
                    Text("Imported \(result.migrated) \(self.memoryLabel(result.migrated)).")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.green)
                }
                if let error = provider.inlineError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .toggleStyle(.checkbox)
        .disabled(self.memoryImport.isApplying || !provider.isActionable)
    }

    private func memoryImportProgress(title: String, detail: String) -> some View {
        self.onboardingCard {
            HStack(spacing: 14) {
                ProgressView()
                    .controlSize(.regular)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.headline)
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: 520)
    }

    private func memoryImportFailure(message: String) -> some View {
        VStack(spacing: 14) {
            self.onboardingCard {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.title2)
                        .foregroundStyle(.orange)
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Couldn’t check for memories")
                            .font(.headline)
                        Text(message)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            Button("Retry") {
                Task { await self.memoryImport.startPlanning(gateway: self.memoryImportGateway) }
            }
            .buttonStyle(.borderedProminent)

            Text("You can do this later from the dashboard’s Memory import page.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: 520)
    }

    private func memoryImportResults(_ results: [OnboardingMemoryImportModel.ProviderResult]) -> some View {
        let imported = results.reduce(0) { $0 + $1.migrated }
        return VStack(spacing: 14) {
            self.onboardingCard(spacing: 12) {
                Label("Your memories are ready", systemImage: "checkmark.circle.fill")
                    .font(.headline)
                    .foregroundStyle(.green)
                Text("Imported \(imported) \(self.memoryLabel(imported)) into OpenClaw.")
                    .font(.body)
                ForEach(results) { result in
                    HStack {
                        Text(result.label)
                        Spacer()
                        Text("\(result.migrated) imported")
                            .foregroundStyle(.secondary)
                    }
                    .font(.subheadline)
                }
            }
            Text("You can manage imported memories anytime from the dashboard.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: 520)
    }

    private func memoryLabel(_ count: Int) -> String {
        count == 1 ? "memory" : "memories"
    }

    func updateMemoryImportMonitoring(for pageIndex: Int) {
        self.memoryImport.setPageActive(pageIndex == self.memoryImportPageIndex)
        self.maybeStartMemoryImportPlanning()
    }

    func maybeStartMemoryImportPlanning() {
        guard self.state.connectionMode == .local,
              self.aiSetup.connected,
              self.memoryImport.shouldStartAutomatically
        else { return }
        Task { await self.memoryImport.startPlanning(gateway: self.memoryImportGateway) }
    }
}
