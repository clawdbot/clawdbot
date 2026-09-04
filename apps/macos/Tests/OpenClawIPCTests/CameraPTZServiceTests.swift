import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct CameraPTZServiceTests {
    private enum FakeFailure: LocalizedError {
        case panTilt
        case zoom
        case status

        var errorDescription: String? {
            switch self {
            case .panTilt: "pan/tilt write failed"
            case .zoom: "zoom write failed"
            case .status: "status read failed"
            }
        }
    }

    private final class AccessProbe: @unchecked Sendable {
        private let lock = NSLock()
        private var active = 0
        private(set) var peak = 0

        func run() {
            self.lock.lock()
            self.active += 1
            self.peak = max(self.peak, self.active)
            self.lock.unlock()
            Thread.sleep(forTimeInterval: 0.02)
            self.lock.lock()
            self.active -= 1
            self.lock.unlock()
        }
    }

    private final class FakeDevice: @unchecked Sendable {
        var rawStatus: CameraPTZRawStatus
        var statusHook: (() -> Void)?
        var panTiltHook: (() -> Void)?
        var panTiltWrites: [(Int32, Int32)] = []
        var zoomWrites: [Int32] = []
        var closeCount = 0
        var panTiltError: Error?
        var zoomError: Error?
        var statusFailureCalls: Set<Int> = []
        var statusCalls = 0
        var openCount = 0
        var acceptsWrites = true
        var panLandingOffset: Int32 = 0
        var events: [String] = []

        init(status: CameraPTZRawStatus) {
            self.rawStatus = status
        }
    }

    private final class FakeController: CameraPTZControlling, @unchecked Sendable {
        private let device: FakeDevice
        private let connection: Int
        private var pendingPanTilt: (pan: Int32, tilt: Int32)?
        private var pendingZoom: Int32?
        private var closed = false

        var statusHook: (() -> Void)? {
            get { self.device.statusHook }
            set { self.device.statusHook = newValue }
        }

        var panTiltHook: (() -> Void)? {
            get { self.device.panTiltHook }
            set { self.device.panTiltHook = newValue }
        }

        var panTiltWrites: [(Int32, Int32)] {
            self.device.panTiltWrites
        }

        var zoomWrites: [Int32] {
            self.device.zoomWrites
        }

        var closeCount: Int {
            self.device.closeCount
        }

        var events: [String] {
            self.device.events
        }

        var acceptsWrites: Bool {
            get { self.device.acceptsWrites }
            set { self.device.acceptsWrites = newValue }
        }

        var panLandingOffset: Int32 {
            get { self.device.panLandingOffset }
            set { self.device.panLandingOffset = newValue }
        }

        var panTiltError: Error? {
            get { self.device.panTiltError }
            set { self.device.panTiltError = newValue }
        }

        var zoomError: Error? {
            get { self.device.zoomError }
            set { self.device.zoomError = newValue }
        }

        var statusFailureCalls: Set<Int> {
            get { self.device.statusFailureCalls }
            set { self.device.statusFailureCalls = newValue }
        }

        init(status: CameraPTZRawStatus) {
            self.device = FakeDevice(status: status)
            self.connection = 0
        }

        private init(device: FakeDevice, connection: Int) {
            self.device = device
            self.connection = connection
        }

        func openConnection() -> FakeController {
            self.device.openCount += 1
            let connection = self.device.openCount
            self.device.events.append("open:\(connection)")
            return FakeController(device: self.device, connection: connection)
        }

        func withCaptureSession<T>(_ body: () throws -> T) rethrows -> T {
            self.device.events.append("session:start")
            defer { self.device.events.append("session:stop") }
            return try body()
        }

        func status() throws -> CameraPTZRawStatus {
            self.device.statusHook?()
            self.device.statusCalls += 1
            self.device.events.append("status:\(self.connection)")
            if self.device.statusFailureCalls.remove(self.device.statusCalls) != nil {
                throw FakeFailure.status
            }
            let committed = self.device.rawStatus
            return CameraPTZRawStatus(
                pan: committed.pan.map {
                    CameraPTZRawAxisStatus(
                        current: self.pendingPanTilt?.pan ?? $0.current,
                        range: $0.range,
                        canSet: $0.canSet)
                },
                tilt: committed.tilt.map {
                    CameraPTZRawAxisStatus(
                        current: self.pendingPanTilt?.tilt ?? $0.current,
                        range: $0.range,
                        canSet: $0.canSet)
                },
                zoom: committed.zoom.map {
                    CameraPTZRawAxisStatus(
                        current: self.pendingZoom ?? $0.current,
                        range: $0.range,
                        canSet: $0.canSet)
                })
        }

        func setPanTilt(pan: Int32, tilt: Int32) throws {
            if let panTiltError = self.device.panTiltError { throw panTiltError }
            self.device.panTiltHook?()
            self.device.panTiltWrites.append((pan, tilt))
            self.device.events.append("write:panTilt:\(self.connection)")
            self.pendingPanTilt = (pan, tilt)
            guard self.device.acceptsWrites else { return }
            let committed = self.device.rawStatus
            self.device.rawStatus = CameraPTZRawStatus(
                pan: committed.pan.map {
                    CameraPTZRawAxisStatus(
                        current: pan + self.device.panLandingOffset,
                        range: $0.range,
                        canSet: $0.canSet)
                },
                tilt: committed.tilt.map {
                    CameraPTZRawAxisStatus(current: tilt, range: $0.range, canSet: $0.canSet)
                },
                zoom: committed.zoom)
        }

        func setZoom(_ zoom: Int32) throws {
            if let zoomError = self.device.zoomError { throw zoomError }
            self.device.zoomWrites.append(zoom)
            self.device.events.append("write:zoom:\(self.connection)")
            self.pendingZoom = zoom
            guard self.device.acceptsWrites else { return }
            let committed = self.device.rawStatus
            self.device.rawStatus = CameraPTZRawStatus(
                pan: committed.pan,
                tilt: committed.tilt,
                zoom: committed.zoom.map {
                    CameraPTZRawAxisStatus(current: zoom, range: $0.range, canSet: $0.canSet)
                })
        }

        func close() {
            guard !self.closed else { return }
            self.closed = true
            self.device.closeCount += 1
            self.device.events.append("close:\(self.connection)")
        }
    }

    private struct FakeBackend: CameraPTZBackend {
        let controller: FakeController

        func open(deviceId _: String) -> any CameraPTZControlling {
            self.controller.openConnection()
        }

        func withCaptureSession<T>(deviceId _: String, body: () throws -> T) rethrows -> T {
            try self.controller.withCaptureSession(body)
        }
    }

    private static let panRange = CameraPTZRawRange(
        min: -360_000,
        max: 360_000,
        step: 3600,
        default: 0)
    private static let tiltRange = CameraPTZRawRange(
        min: -180_000,
        max: 180_000,
        step: 1800,
        default: 0)
    private static let zoomRange = CameraPTZRawRange(
        min: 100,
        max: 500,
        step: 20,
        default: 100)

    private func makeController(
        includeZoom: Bool = true,
        canSet: Bool = true,
        defaultsAvailable: Bool = true,
        pan: Int32 = 0,
        tilt: Int32 = 0) -> FakeController
    {
        let panRange = Self.panRange.withDefault(defaultsAvailable ? 0 : nil)
        let tiltRange = Self.tiltRange.withDefault(defaultsAvailable ? 0 : nil)
        let zoomRange = Self.zoomRange.withDefault(defaultsAvailable ? 100 : nil)
        return FakeController(status: CameraPTZRawStatus(
            pan: CameraPTZRawAxisStatus(current: pan, range: panRange, canSet: canSet),
            tilt: CameraPTZRawAxisStatus(current: tilt, range: tiltRange, canSet: canSet),
            zoom: includeZoom
                ? CameraPTZRawAxisStatus(current: 300, range: zoomRange, canSet: canSet)
                : nil))
    }

    private func makeService(_ controller: FakeController) -> CameraPTZService {
        CameraPTZService(
            backend: FakeBackend(controller: controller),
            deviceExists: { $0 == "camera-id" })
    }

    private func videoControlDescriptors(
        _ descriptors: [UInt8],
        reportedLength: UInt16? = nil) -> [UInt8]
    {
        let actualLength = UInt16(13 + descriptors.count)
        let totalLength = reportedLength ?? actualLength
        return [
            13, 0x24, 0x01, 0x10, 0x01,
            UInt8(truncatingIfNeeded: totalLength),
            UInt8(truncatingIfNeeded: totalLength >> 8),
            0, 0, 0, 0, 1, 1,
        ] + descriptors
    }

    private func cameraTerminal(
        id: UInt8,
        controls: UInt16,
        controlSize: UInt8 = 2) -> [UInt8]
    {
        let requiredControls = [
            UInt8(truncatingIfNeeded: controls),
            UInt8(truncatingIfNeeded: controls >> 8),
        ]
        let controlBytes = controlSize < 2
            ? Array(requiredControls.prefix(Int(controlSize)))
            : requiredControls + Array(repeating: 0, count: Int(controlSize) - 2)
        return [
            UInt8(15 + controlBytes.count),
            0x24, 0x02, id, 0x01, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, controlSize,
        ] + controlBytes
    }

    @Test func `range clamps snaps and converts zoom percentages`() {
        let range = CameraPTZRawRange(min: 100, max: 500, step: 20, default: 100)

        #expect(range.normalize(111) == 120)
        #expect(range.normalize(90) == 100)
        #expect(range.normalize(510) == 500)
        #expect(range.percent(of: 300) == 50)
        #expect(range.value(percent: 52) == 300)
        #expect(range.value(percent: 200) == 500)
    }

    @Test func `unknown explicit capture device never falls back to another camera`() {
        var selectedFallback = false

        #expect(throws: CameraPTZError.deviceNotFound("missing")) {
            try CameraCapturePipelineSupport.selectCamera(
                deviceId: "missing",
                matching: { _ in nil as String? },
                fallback: {
                    selectedFallback = true
                    return "different-camera"
                },
                unavailableError: CameraCaptureService.CameraError.cameraUnavailable,
                deviceNotFoundError: { CameraPTZError.deviceNotFound($0) })
        }
        #expect(!selectedFallback)
    }

    @Test func `capture without an explicit device preserves facing camera fallback`() throws {
        for deviceId in [nil, ""] as [String?] {
            let selected = try CameraCapturePipelineSupport.selectCamera(
                deviceId: deviceId,
                matching: { _ in nil as String? },
                fallback: { "facing-camera" },
                unavailableError: CameraCaptureService.CameraError.cameraUnavailable,
                deviceNotFoundError: { CameraPTZError.deviceNotFound($0) })

            #expect(selected == "facing-camera")
        }
    }

    @Test func `USB identity uses AVFoundation packed identifier`() throws {
        let identity = try CameraUSBIdentity.parse(deviceId: "0x21100002e1a4c06")

        #expect(identity.locationId == 0x0211_0000)
        #expect(identity.vendorId == 0x2E1A)
        #expect(identity.productId == 0x4C06)
    }

    @Test func `descriptor parser extracts PTZ bits and camera terminal ID`() throws {
        let controls = UInt16(1 << 9 | 1 << 11)
        let descriptors = self.videoControlDescriptors(self.cameraTerminal(id: 7, controls: controls))

        let parsed = try #require(CameraUVCDescriptorParser.parse(descriptors))
        #expect(parsed.terminalId == 7)
        #expect(parsed.controls == UInt32(controls))
    }

    @Test func `descriptor parser bounds oversized VC total length by supplied buffer`() throws {
        let controls = UInt16(1 << 9)
        let descriptors = self.videoControlDescriptors(
            self.cameraTerminal(id: 8, controls: controls),
            reportedLength: .max)

        let parsed = try #require(CameraUVCDescriptorParser.parse(descriptors))
        #expect(parsed.terminalId == 8)
        #expect(parsed.controls == UInt32(controls))
    }

    @Test func `descriptor parser rejects malformed camera controls`() {
        let truncatedTerminal: [UInt8] = [
            17, 0x24, 0x02, 7, 0x01, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0,
        ]
        let undersizedControls = self.cameraTerminal(id: 7, controls: 0, controlSize: 1)
        let oversizedControls: [UInt8] = [
            17, 0x24, 0x02, 7, 0x01, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0,
        ]

        #expect(CameraUVCDescriptorParser.parse(self.videoControlDescriptors(truncatedTerminal)) == nil)
        #expect(CameraUVCDescriptorParser.parse(self.videoControlDescriptors(undersizedControls)) == nil)
        #expect(CameraUVCDescriptorParser.parse(self.videoControlDescriptors(oversizedControls)) == nil)
    }

    @Test func `descriptor parser reads only required controls from oversized control size`() throws {
        let controls = UInt16(1 << 9 | 1 << 11)
        let descriptors = self.videoControlDescriptors(
            self.cameraTerminal(id: 8, controls: controls, controlSize: 3))

        let parsed = try #require(CameraUVCDescriptorParser.parse(descriptors))
        #expect(parsed.terminalId == 8)
        #expect(parsed.controls == UInt32(controls))
    }

    @Test func `descriptor parser skips a non camera input terminal`() throws {
        let controls = UInt16(1 << 11)
        let nonCameraTerminal: [UInt8] = [8, 0x24, 0x02, 4, 0x01, 0x01, 0, 0]
        let descriptors = self.videoControlDescriptors(
            nonCameraTerminal + self.cameraTerminal(id: 9, controls: controls))

        let parsed = try #require(CameraUVCDescriptorParser.parse(descriptors))
        #expect(parsed.terminalId == 9)
        #expect(parsed.controls == UInt32(controls))
    }

    @Test func `control info requires the UVC set capability`() {
        #expect(!CameraUVCControlInfo.canSet(nil))
        #expect(!CameraUVCControlInfo.canSet(0x01))
        #expect(CameraUVCControlInfo.canSet(0x03))
    }

    @Test func `status exposes normalized axes without raw UVC details`() async throws {
        let controller = self.makeController()
        let response = try await self.makeService(controller).status(deviceId: "camera-id")

        #expect(response.deviceId == "camera-id")
        #expect(response.axes.pan?.unit == "degrees")
        #expect(response.axes.pan?.min == -100)
        #expect(response.axes.pan?.step == 1)
        #expect(response.axes.zoom?.unit == "percent")
        #expect(response.axes.zoom?.current == 50)
        #expect(response.axes.zoom?.step == 5)
        #expect(response.canHome)
        #expect(controller.closeCount == 1)
    }

    @Test func `status keeps the capture stream active around all UVC access`() async throws {
        let controller = self.makeController()

        _ = try await self.makeService(controller).status(deviceId: "camera-id")

        #expect(controller.events == [
            "session:start", "open:1", "status:1", "close:1", "session:stop",
        ])
    }

    @Test func `control closes its writer before verifying on a fresh connection`() async throws {
        let controller = self.makeController()

        let response = try await self.makeService(controller).control(OpenClawCameraPTZControlParams(
            deviceId: "camera-id",
            operation: .set,
            target: OpenClawCameraPTZAxisValues(panDegrees: 5)))

        #expect(response.state.panDegrees == 5)
        #expect(controller.events == [
            "session:start", "open:1", "status:1", "write:panTilt:1", "close:1",
            "open:2", "status:2", "close:2", "session:stop",
        ])
    }

    @Test func `connection local setpoint echoes never turn ignored motion into success`() async {
        let controller = self.makeController()
        controller.acceptsWrites = false

        do {
            _ = try await self.makeService(controller).control(OpenClawCameraPTZControlParams(
                deviceId: "camera-id",
                operation: .set,
                target: OpenClawCameraPTZAxisValues(panDegrees: 5, zoomPercent: 75)))
            Issue.record("the writer echoed ignored setpoints as a successful physical move")
        } catch let CameraPTZError.partial(applied, state, failure) {
            #expect(applied == ["panTilt", "zoom"])
            #expect(state == CameraPTZState(panDegrees: 0, tiltDegrees: 0, zoomPercent: 50))
            #expect(failure.contains("panDegrees requested=5.0 observed=0.0"))
            #expect(failure.contains("zoomPercent requested=75.0 observed=50.0"))
            #expect(failure.contains("video stream"))
            #expect(failure.contains("AI framing/tracking"))
            #expect(controller.events.contains("open:2"))
            #expect(controller.events.last == "session:stop")
        } catch {
            Issue.record("unexpected error: \(error)")
        }
    }

    @Test func `verified motion within one advertised axis step still succeeds`() async throws {
        let controller = self.makeController()
        controller.panLandingOffset = 1800

        let response = try await self.makeService(controller).control(OpenClawCameraPTZControlParams(
            deviceId: "camera-id",
            operation: .set,
            target: OpenClawCameraPTZAxisValues(panDegrees: 5)))

        #expect(response.state.panDegrees == 5.5)
    }

    @Test func `readable axes without SET capability are not exposed or writable`() async throws {
        let controller = self.makeController(canSet: false)
        let service = self.makeService(controller)
        let status = try await service.status(deviceId: "camera-id")

        #expect(status.axes.pan == nil)
        #expect(status.axes.tilt == nil)
        #expect(status.axes.zoom == nil)
        #expect(!status.canHome)
        await #expect(throws: CameraPTZError.axisUnsupported("pan")) {
            try await service.control(OpenClawCameraPTZControlParams(
                deviceId: "camera-id",
                operation: .set,
                target: OpenClawCameraPTZAxisValues(panDegrees: 5)))
        }
        #expect(controller.panTiltWrites.isEmpty)
        #expect(controller.zoomWrites.isEmpty)
    }

    @Test func `set clamps snaps preserves omitted axes and reports adjustments`() async throws {
        let controller = self.makeController()
        let response = try await self.makeService(controller).control(OpenClawCameraPTZControlParams(
            deviceId: "camera-id",
            operation: .set,
            target: OpenClawCameraPTZAxisValues(panDegrees: 120.2, zoomPercent: 53)))

        #expect(controller.panTiltWrites.count == 1)
        #expect(controller.panTiltWrites.first?.0 == 360_000)
        #expect(controller.panTiltWrites.first?.1 == 0)
        #expect(controller.zoomWrites == [320])
        #expect(response.state.panDegrees == 100)
        #expect(response.state.tiltDegrees == 0)
        #expect(abs((response.state.zoomPercent ?? 0) - 55) < 1e-9)
        #expect(response.adjusted == ["panDegrees", "zoomPercent"])
    }

    @Test func `move reads current then writes absolute values`() async throws {
        let controller = self.makeController()
        let response = try await self.makeService(controller).control(OpenClawCameraPTZControlParams(
            deviceId: "camera-id",
            operation: .move,
            delta: OpenClawCameraPTZAxisValues(panDegrees: 2, tiltDegrees: -1, zoomPercent: 10)))

        #expect(controller.panTiltWrites.first?.0 == 7200)
        #expect(controller.panTiltWrites.first?.1 == -3600)
        #expect(controller.zoomWrites == [340])
        #expect(response.state.panDegrees == 2)
        #expect(response.state.tiltDegrees == -1)
        #expect(response.state.zoomPercent == 60)
        #expect(response.adjusted.isEmpty)
    }

    @Test func `combined pan tilt write preserves omitted off grid raw axis`() async throws {
        let controller = self.makeController(tilt: 1234)

        _ = try await self.makeService(controller).control(OpenClawCameraPTZControlParams(
            deviceId: "camera-id",
            operation: .set,
            target: OpenClawCameraPTZAxisValues(panDegrees: 2)))

        #expect(controller.panTiltWrites.count == 1)
        #expect(controller.panTiltWrites.first?.0 == 7200)
        #expect(controller.panTiltWrites.first?.1 == 1234)
    }

    @Test func `unsupported requested axis fails before mutation`() async {
        let controller = self.makeController(includeZoom: false)
        let service = self.makeService(controller)

        await #expect(throws: CameraPTZError.axisUnsupported("zoom")) {
            try await service.control(OpenClawCameraPTZControlParams(
                deviceId: "camera-id",
                operation: .set,
                target: OpenClawCameraPTZAxisValues(panDegrees: 5, zoomPercent: 20)))
        }
        #expect(controller.panTiltWrites.isEmpty)
        #expect(controller.closeCount == 1)
    }

    @Test func `home restores backend defaults and returns post operation state`() async throws {
        let controller = self.makeController()
        try controller.setPanTilt(pan: 36000, tilt: 18000)
        try controller.setZoom(400)

        let response = try await self.makeService(controller).control(OpenClawCameraPTZControlParams(
            deviceId: "camera-id",
            operation: .home))

        #expect(controller.panTiltWrites.last?.0 == 0)
        #expect(controller.panTiltWrites.last?.1 == 0)
        #expect(controller.zoomWrites.last == 100)
        #expect(response.state == CameraPTZState(panDegrees: 0, tiltDegrees: 0, zoomPercent: 0))
        #expect(response.adjusted.isEmpty)
    }

    @Test func `missing device defaults disable home without synthetic writes`() async throws {
        let controller = self.makeController(defaultsAvailable: false)
        let service = self.makeService(controller)
        let status = try await service.status(deviceId: "camera-id")

        #expect(status.axes.pan?.default == nil)
        #expect(status.axes.zoom?.default == nil)
        #expect(!status.canHome)
        await #expect(throws: CameraPTZError.unsupported(
            "home requires device-advertised defaults for every executable axis"))
        {
            try await service.control(OpenClawCameraPTZControlParams(
                deviceId: "camera-id",
                operation: .home))
        }
        #expect(controller.panTiltWrites.isEmpty)
        #expect(controller.zoomWrites.isEmpty)
    }

    @Test func `later zoom failure reports applied pan tilt and best effort state`() async {
        let controller = self.makeController()
        controller.zoomError = FakeFailure.zoom

        do {
            _ = try await self.makeService(controller).control(OpenClawCameraPTZControlParams(
                deviceId: "camera-id",
                operation: .set,
                target: OpenClawCameraPTZAxisValues(panDegrees: 5, zoomPercent: 75)))
            Issue.record("partial write unexpectedly succeeded")
        } catch let error as CameraPTZError {
            guard case let .partial(applied, state, failure) = error else {
                Issue.record("unexpected PTZ error: \(error)")
                return
            }
            #expect(applied == ["panTilt"])
            #expect(state?.panDegrees == 5)
            #expect(state?.zoomPercent == 50)
            #expect(failure == "zoom write failed")
            #expect(error.localizedDescription.hasPrefix("CAMERA_PTZ_PARTIAL: applied=panTilt;"))
            #expect(error.localizedDescription.hasSuffix("run camera.ptz.status before retrying"))
        } catch {
            Issue.record("unexpected error: \(error)")
        }
    }

    @Test func `final status failure reports every applied control group`() async {
        let controller = self.makeController()
        controller.statusFailureCalls = [2]

        do {
            _ = try await self.makeService(controller).control(OpenClawCameraPTZControlParams(
                deviceId: "camera-id",
                operation: .set,
                target: OpenClawCameraPTZAxisValues(panDegrees: 5, zoomPercent: 75)))
            Issue.record("status failure unexpectedly succeeded")
        } catch let CameraPTZError.partial(applied, state, failure) {
            #expect(applied == ["panTilt", "zoom"])
            #expect(state?.panDegrees == 5)
            #expect(state?.zoomPercent == 75)
            #expect(failure == "status read failed")
        } catch {
            Issue.record("unexpected error: \(error)")
        }
    }

    @Test func `home reports partial outcome when later default write fails`() async {
        let controller = self.makeController()
        controller.zoomError = FakeFailure.zoom

        do {
            _ = try await self.makeService(controller).control(OpenClawCameraPTZControlParams(
                deviceId: "camera-id",
                operation: .home))
            Issue.record("partial home unexpectedly succeeded")
        } catch let CameraPTZError.partial(applied, state, _) {
            #expect(applied == ["panTilt"])
            #expect(state?.panDegrees == 0)
            #expect(state?.zoomPercent == 50)
        } catch {
            Issue.record("unexpected error: \(error)")
        }
    }

    @Test func `requires explicit known device and valid operation shape`() async {
        let controller = self.makeController()
        let service = self.makeService(controller)

        await #expect(throws: CameraPTZError.invalidRequest("deviceId is required")) {
            try await service.status(deviceId: " ")
        }
        await #expect(throws: CameraPTZError.deviceNotFound("missing")) {
            try await service.status(deviceId: "missing")
        }
        await #expect(throws: CameraPTZError.invalidRequest("set and move require at least one axis")) {
            try await service.control(OpenClawCameraPTZControlParams(
                deviceId: "camera-id",
                operation: .move,
                delta: OpenClawCameraPTZAxisValues()))
        }
        await #expect(throws: CameraPTZError.invalidRequest("axis values must be finite")) {
            try await service.control(OpenClawCameraPTZControlParams(
                deviceId: "camera-id",
                operation: .set,
                target: OpenClawCameraPTZAxisValues(panDegrees: .infinity)))
        }
        await #expect(throws: CameraPTZError.invalidRequest("home does not accept target or delta")) {
            try await service.control(OpenClawCameraPTZControlParams(
                deviceId: "camera-id",
                operation: .home,
                target: OpenClawCameraPTZAxisValues(panDegrees: 0)))
        }
        #expect(controller.closeCount == 0)
    }

    @Test func `service serializes native controller access`() async throws {
        let controller = self.makeController()
        let probe = AccessProbe()
        controller.statusHook = { probe.run() }
        let service = self.makeService(controller)

        async let first = service.status(deviceId: "camera-id")
        async let second = service.status(deviceId: "camera-id")
        _ = try await (first, second)

        #expect(probe.peak == 1)
        #expect(controller.closeCount == 2)
    }

    @Test func `cancellation after preflight prevents the first hardware write`() async {
        let controller = self.makeController()
        controller.statusHook = {
            withUnsafeCurrentTask { $0?.cancel() }
        }
        let service = self.makeService(controller)
        let control = Task { () -> Result<CameraPTZControlResponse, Error> in
            do {
                return try await .success(service.control(OpenClawCameraPTZControlParams(
                    deviceId: "camera-id",
                    operation: .set,
                    target: OpenClawCameraPTZAxisValues(panDegrees: 5, zoomPercent: 50))))
            } catch {
                return .failure(error)
            }
        }

        guard case let .failure(error) = await control.value else {
            Issue.record("canceled control unexpectedly succeeded")
            return
        }
        #expect(error is CancellationError)
        #expect(controller.panTiltWrites.isEmpty)
        #expect(controller.zoomWrites.isEmpty)
    }

    @Test func `cancellation after first write does not split planned hardware sequence`() async {
        let controller = self.makeController()
        controller.panTiltHook = {
            withUnsafeCurrentTask { $0?.cancel() }
        }

        let service = self.makeService(controller)
        let control = Task { () -> Result<CameraPTZControlResponse, Error> in
            do {
                return try await .success(service.control(OpenClawCameraPTZControlParams(
                    deviceId: "camera-id",
                    operation: .set,
                    target: OpenClawCameraPTZAxisValues(panDegrees: 5, zoomPercent: 75))))
            } catch {
                return .failure(error)
            }
        }

        guard case .success = await control.value else {
            Issue.record("post-admission cancellation split the control sequence")
            return
        }
        #expect(controller.panTiltWrites.count == 1)
        #expect(controller.zoomWrites == [400])
    }
}
