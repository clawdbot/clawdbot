import Foundation
import Testing
@testable import OpenClaw

struct AudioInputDeviceObserverTests {
    @Test func `selected available input wins over system default`() {
        let result = AudioInputDeviceSelectionResolver.resolve(
            selectedUID: "desk-mic",
            availableUIDs: ["desk-mic", "built-in"],
            defaultUID: "built-in")

        #expect(result == AudioInputDeviceResolution(
            selectedUID: "desk-mic",
            resolvedUID: "desk-mic",
            fellBackToSystemDefault: false))
        #expect(result.shouldBindSelectedDevice)
    }

    @Test func `missing selected input falls back without replacing selection`() {
        let result = AudioInputDeviceSelectionResolver.resolve(
            selectedUID: "desk-mic",
            availableUIDs: ["built-in"],
            defaultUID: "built-in")

        #expect(result == AudioInputDeviceResolution(
            selectedUID: "desk-mic",
            resolvedUID: "built-in",
            fellBackToSystemDefault: true))
        #expect(!result.shouldBindSelectedDevice)
    }

    @Test func `system default and unavailable states resolve explicitly`() {
        let systemDefault = AudioInputDeviceSelectionResolver.resolve(
            selectedUID: "",
            availableUIDs: ["built-in"],
            defaultUID: "built-in")
        let unavailable = AudioInputDeviceSelectionResolver.resolve(
            selectedUID: nil,
            availableUIDs: [],
            defaultUID: "built-in")

        #expect(systemDefault.resolvedUID == "built-in")
        #expect(systemDefault.selectedUID == nil)
        #expect(unavailable.resolvedUID == nil)
    }

    @Test func `default and fallback follow default changes while selected input does not`() {
        let systemDefault = AudioInputDeviceResolution(
            selectedUID: nil,
            resolvedUID: "built-in",
            fellBackToSystemDefault: false)
        let fallback = AudioInputDeviceResolution(
            selectedUID: "desk-mic",
            resolvedUID: "built-in",
            fellBackToSystemDefault: true)
        let selected = AudioInputDeviceResolution(
            selectedUID: "desk-mic",
            resolvedUID: "desk-mic",
            fellBackToSystemDefault: false)
        let available = Set(["built-in", "new-default", "desk-mic"])

        #expect(systemDefault.shouldRestart(availableUIDs: available, defaultUID: "new-default"))
        #expect(fallback.shouldRestart(availableUIDs: available, defaultUID: "new-default"))
        #expect(!selected.shouldRestart(availableUIDs: available, defaultUID: "new-default"))
        #expect(selected.shouldRestart(availableUIDs: ["built-in"], defaultUID: "built-in"))
    }

    @Test func `has usable default input device returns bool`() {
        // Smoke test: verifies the composition logic runs without crashing.
        // Actual result depends on whether the host has an audio input device.
        let result = AudioInputDeviceObserver.hasUsableDefaultInputDevice()
        _ = result // suppress unused-variable warning; the assertion is "no crash"
    }

    @Test func `has usable default input device consistent with components`() {
        // When no default UID exists, the method must return false.
        // When a default UID exists, the result must match alive-set membership.
        let uid = AudioInputDeviceObserver.defaultInputDeviceUID()
        let alive = AudioInputDeviceObserver.aliveInputDeviceUIDs()
        let expected = uid.map { alive.contains($0) } ?? false
        #expect(AudioInputDeviceObserver.hasUsableDefaultInputDevice() == expected)
    }
}
