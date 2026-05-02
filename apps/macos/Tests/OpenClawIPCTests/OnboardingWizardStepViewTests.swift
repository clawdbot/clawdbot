import OpenClawProtocol
import SwiftUI
import Testing
@testable import OpenClaw

private typealias ProtoAnyCodable = OpenClawProtocol.AnyCodable

@Suite(.serialized)
@MainActor
struct OnboardingWizardStepViewTests {
    @Test func `note step builds`() {
        let step = WizardStep(
            id: "step-1",
            type: ProtoAnyCodable("note"),
            title: "Welcome",
            message: "Hello",
            format: nil,
            options: nil,
            initialvalue: nil,
            placeholder: nil,
            sensitive: nil,
            executor: nil)
        let view = OnboardingWizardStepView(step: step, isSubmitting: false, onSubmit: { _ in })
        _ = view.body
    }

    @Test func `select step builds`() {
        let options: [[String: ProtoAnyCodable]] = [
            ["value": ProtoAnyCodable("local"), "label": ProtoAnyCodable("Local"), "hint": ProtoAnyCodable("This Mac")],
            ["value": ProtoAnyCodable("remote"), "label": ProtoAnyCodable("Remote")],
        ]
        let step = WizardStep(
            id: "step-2",
            type: ProtoAnyCodable("select"),
            title: "Mode",
            message: "Choose a mode",
            format: nil,
            options: options,
            initialvalue: ProtoAnyCodable("local"),
            placeholder: nil,
            sensitive: nil,
            executor: nil)
        let view = OnboardingWizardStepView(step: step, isSubmitting: false, onSubmit: { _ in })
        _ = view.body
    }
}
