import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct CameraPTZRuntimeTests {
    private actor FakePTZService: CameraPTZServicing {
        var statusDeviceId: String?
        var controlParams: OpenClawCameraPTZControlParams?
        let controlError: CameraPTZError?

        init(controlError: CameraPTZError? = nil) {
            self.controlError = controlError
        }

        func status(deviceId: String) -> CameraPTZStatusResponse {
            self.statusDeviceId = deviceId
            return CameraPTZStatusResponse(
                deviceId: deviceId,
                axes: CameraPTZAxesStatus(
                    pan: CameraPTZAxisStatus(
                        current: 0,
                        min: -90,
                        max: 90,
                        step: 1,
                        default: 0,
                        unit: "degrees",
                        canSet: true,
                        canMove: true),
                    tilt: nil,
                    zoom: nil),
                canHome: true)
        }

        func control(_ params: OpenClawCameraPTZControlParams) throws -> CameraPTZControlResponse {
            self.controlParams = params
            if let controlError { throw controlError }
            return CameraPTZControlResponse(
                deviceId: params.deviceId,
                operation: params.operation,
                state: CameraPTZState(panDegrees: 5, tiltDegrees: nil, zoomPercent: nil),
                adjusted: [])
        }
    }

    private func invoke(
        _ runtime: MacNodeRuntime,
        command: OpenClawCameraCommand,
        params: some Encodable) async throws -> BridgeInvokeResponse
    {
        let paramsJSON = try String(decoding: JSONEncoder().encode(params), as: UTF8.self)
        return await runtime.handleInvoke(BridgeInvokeRequest(
            id: "ptz-request",
            command: command.rawValue,
            paramsJSON: paramsJSON,
            nodeId: nil))
    }

    @Test func `PTZ commands use camera enablement gate`() async throws {
        try await TestIsolation.withUserDefaultsValues([cameraEnabledKey: false]) {
            let service = FakePTZService()
            let runtime = MacNodeRuntime(cameraPTZ: service)
            let response = try await self.invoke(
                runtime,
                command: .ptzStatus,
                params: OpenClawCameraPTZStatusParams(deviceId: "camera-id"))

            #expect(!response.ok)
            #expect(response.error?.message == "CAMERA_DISABLED: enable Camera in Settings")
            #expect(await service.statusDeviceId == nil)
        }
    }

    @Test func `PTZ status routes explicit device and encodes response`() async throws {
        try await TestIsolation.withUserDefaultsValues([cameraEnabledKey: true]) {
            let service = FakePTZService()
            let runtime = MacNodeRuntime(cameraPTZ: service)
            let response = try await self.invoke(
                runtime,
                command: .ptzStatus,
                params: OpenClawCameraPTZStatusParams(deviceId: "camera-id"))

            #expect(response.ok)
            #expect(await service.statusDeviceId == "camera-id")
            let payload = try #require(response.payloadJSON)
            #expect(payload.contains(#""deviceId":"camera-id""#))
            #expect(payload.contains(#""unit":"degrees""#))
        }
    }

    @Test func `PTZ control routes closed operation payload`() async throws {
        try await TestIsolation.withUserDefaultsValues([cameraEnabledKey: true]) {
            let service = FakePTZService()
            let runtime = MacNodeRuntime(cameraPTZ: service)
            let params = OpenClawCameraPTZControlParams(
                deviceId: "camera-id",
                operation: .move,
                delta: OpenClawCameraPTZAxisValues(panDegrees: 5))
            let response = try await self.invoke(runtime, command: .ptzControl, params: params)

            #expect(response.ok)
            #expect(await service.controlParams == params)
            #expect(response.payloadJSON?.contains(#""operation":"move""#) == true)
        }
    }

    @Test func `PTZ malformed payload returns stable invalid request prefix`() async {
        await TestIsolation.withUserDefaultsValues([cameraEnabledKey: true]) {
            let runtime = MacNodeRuntime(cameraPTZ: FakePTZService())
            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "ptz-invalid",
                command: OpenClawCameraCommand.ptzControl.rawValue,
                paramsJSON: #"{"deviceId":"camera-id","operation":"spin"}"#,
                nodeId: nil))

            #expect(!response.ok)
            #expect(response.error?.code == .invalidRequest)
            #expect(response.error?.message == "INVALID_REQUEST: invalid camera.ptz.control params")
        }
    }

    @Test func `PTZ partial hardware outcome preserves stable error prefix`() async throws {
        try await TestIsolation.withUserDefaultsValues([cameraEnabledKey: true]) {
            let service = FakePTZService(controlError: .partial(
                applied: ["panTilt"],
                state: CameraPTZState(panDegrees: 5, tiltDegrees: 0, zoomPercent: 50),
                failure: "zoom write failed"))
            let runtime = MacNodeRuntime(cameraPTZ: service)
            let response = try await self.invoke(
                runtime,
                command: .ptzControl,
                params: OpenClawCameraPTZControlParams(
                    deviceId: "camera-id",
                    operation: .set,
                    target: OpenClawCameraPTZAxisValues(panDegrees: 5, zoomPercent: 75)))

            #expect(!response.ok)
            #expect(response.error?.code == .unavailable)
            #expect(response.error?.message.hasPrefix("CAMERA_PTZ_PARTIAL: applied=panTilt;") == true)
            #expect(response.error?.message.hasSuffix("run camera.ptz.status before retrying") == true)
        }
    }
}
