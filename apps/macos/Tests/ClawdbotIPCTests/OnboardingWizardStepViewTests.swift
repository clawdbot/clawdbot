import ClawdbotProtocol
import SwiftUI
import Testing
@testable import Clawdbot

@Suite(.serialized)
@MainActor
struct OnboardingWizardStepViewTests {
    @Test func noteStepBuilds() {
        let step = WizardStep(
            id: "step-1",
            type: AnyCodable("note"),
            title: "Welcome",
            message: "Hello",
            options: nil,
            initialvalue: nil,
            placeholder: nil,
            sensitive: nil,
            executor: nil)
        let view = OnboardingWizardStepView(step: step, isSubmitting: false, onSubmit: { _ in })
        _ = view.body
    }

    @Test func selectStepBuilds() {
        let options: [[String: AnyCodable]] = [
            ["value": AnyCodable("local"), "label": AnyCodable("Local"), "hint": AnyCodable("This Mac")],
            ["value": AnyCodable("remote"), "label": AnyCodable("Remote")],
        ]
        let step = WizardStep(
            id: "step-2",
            type: AnyCodable("select"),
            title: "Mode",
            message: "Choose a mode",
            options: options,
            initialvalue: AnyCodable("local"),
            placeholder: nil,
            sensitive: nil,
            executor: nil)
        let view = OnboardingWizardStepView(step: step, isSubmitting: false, onSubmit: { _ in })
        _ = view.body
    }
}
