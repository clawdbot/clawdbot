import OpenClawChatUI
import OpenClawIPC
import SwiftUI

/// Onboarding hero mascot with the openclaw.ai hero treatment: the animated
/// mascot plus its coral silhouette glow (drop-shadow at ~10% of size).
/// Interactive: it reacts to clicks and its eyes follow the pointer.
struct GlowingOpenClawIcon: View {
    @Environment(\.colorScheme) private var colorScheme

    let size: CGFloat
    let mood: OpenClawMascotMood
    let accessory: OpenClawMascotAccessory

    init(
        size: CGFloat = 148,
        mood: OpenClawMascotMood = .idle,
        accessory: OpenClawMascotAccessory = .none)
    {
        self.size = size
        self.mood = mood
        self.accessory = accessory
    }

    var body: some View {
        OpenClawMascotView(mood: self.mood, accessory: self.accessory, interactive: true)
            .frame(width: self.size, height: self.size)
            .shadow(
                color: OpenClawMascotView.heroGlowColor(for: self.colorScheme),
                radius: self.size * 0.1)
    }
}

extension OnboardingView {
    /// Onboarding page classes the mascot reacts to.
    enum MascotPage {
        case welcome
        case connection
        case cli
        case ai
        case memory
        case permissions
        case chat
        case ready
    }

    /// Flow state the mascot mood is derived from.
    struct MascotMoodSnapshot {
        var page: MascotPage
        var installingCLI = false
        var cliInstalled = false
        var cliStatusKnown = false
        var aiPhase: OnboardingAISetupModel.Phase = .idle
        var aiBusy = false
        var aiFailed = false
        var memoryPhase: OnboardingMemoryImportModel.Phase = .idle
        var remoteProbeState: RemoteOnboardingProbeState = .idle
        var allPermissionsGranted = false
    }

    /// The hero mascot mirrors what setup is doing: curious while choosing,
    /// hard-hat working while setup is in flight, sad on failures,
    /// celebrating once the AI answers and on the final page.
    var mascotMood: OpenClawMascotMood {
        Self.mascotMood(for: MascotMoodSnapshot(
            page: self.mascotPage,
            installingCLI: self.installingCLI,
            cliInstalled: self.cliInstalled,
            cliStatusKnown: self.cliStatusKnown,
            aiPhase: self.aiSetup.phase,
            aiBusy: self.aiSetup.isBusy,
            aiFailed: Self.aiSetupLooksFailed(self.aiSetup),
            memoryPhase: self.memoryImport.phase,
            remoteProbeState: self.remoteProbeState,
            allPermissionsGranted: Capability.importanceOrdered
                .allSatisfy { self.permissionMonitor.status[$0]?.isGranted == true }))
    }

    var mascotAccessory: OpenClawMascotAccessory {
        Self.mascotAccessory(for: self.mascotPage)
    }

    private var mascotPage: MascotPage {
        switch self.activePageIndex {
        case self.connectionPageIndex: .connection
        case self.cliPageIndex: .cli
        case self.aiPageIndex: .ai
        case self.memoryImportPageIndex: .memory
        case self.permissionsPageIndex: .permissions
        case self.onboardingChatPageIndex: .chat
        case self.readyPageIndex: .ready
        default: .welcome
        }
    }

    static func aiSetupLooksFailed(_ aiSetup: OnboardingAISetupModel) -> Bool {
        guard !aiSetup.connected else { return false }
        let candidateFailed = aiSetup.statuses.values.contains { status in
            if case .failed = status { return true }
            return false
        }
        return aiSetup.detectError != nil ||
            aiSetup.exhaustedAutoCandidates ||
            aiSetup.manualError != nil ||
            candidateFailed
    }

    static func mascotMood(for snapshot: MascotMoodSnapshot) -> OpenClawMascotMood {
        switch snapshot.page {
        case .welcome:
            .idle
        case .connection:
            switch snapshot.remoteProbeState {
            case .checking: .thinking
            case .failed: .sad
            case .ok: .happy
            case .idle: .curious
            }
        case .cli:
            if snapshot.cliInstalled {
                .happy
            } else if snapshot.cliStatusKnown, !snapshot.installingCLI {
                // Mirrors the page's install-failed card.
                .sad
            } else {
                .working
            }
        case .ai:
            if snapshot.aiPhase == .connected {
                .celebrating
            } else if snapshot.aiBusy {
                .thinking
            } else if snapshot.aiFailed {
                .sad
            } else {
                .curious
            }
        case .memory:
            self.memoryImportMood(for: snapshot.memoryPhase)
        case .permissions:
            snapshot.allPermissionsGranted ? .happy : .curious
        case .chat:
            .attentive
        case .ready:
            .celebrating
        }
    }

    static func mascotAccessory(for page: MascotPage) -> OpenClawMascotAccessory {
        switch page {
        case .ready: .gradCap
        case .welcome, .connection, .cli, .ai, .memory, .permissions, .chat: .none
        }
    }

    static func memoryImportMood(for phase: OnboardingMemoryImportModel.Phase) -> OpenClawMascotMood {
        switch phase {
        case .planning, .applying:
            .thinking
        case .failed:
            .sad
        case .done:
            .happy
        case .idle, .offer, .empty:
            .curious
        }
    }
}
