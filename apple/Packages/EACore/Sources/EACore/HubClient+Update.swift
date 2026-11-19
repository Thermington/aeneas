import Foundation

/// The hub's own software (hub/src/update.ts): Settings, About, Hub software. Check fetches its branch and lists what is
/// new; update runs deploy/update.sh on the hub machine, which restarts the hub and goes back by itself when the new
/// version does not start.
public struct HubUpdateRun: Decodable, Equatable, Sendable {
    /// starting, checking, installing, restarting, rolling_back, done, up_to_date, rolled_back or failed.
    public var state: String
    public var message: String
    public var from: String?
    public var to: String?
    public var at: String
    public var running: Bool { ["starting", "checking", "installing", "restarting", "rolling_back"].contains(state) }
}

public struct HubUpdateInfo: Decodable, Equatable, Sendable {
    public struct Change: Decodable, Equatable, Sendable, Identifiable {
        public var commit: String
        public var title: String
        public var at: String
        public var id: String { commit }
    }
    public var installed_with_git: Bool
    public var commit: String?
    public var committed_at: String?
    public var branch: String
    public var checked_at: String?
    public var latest: String?
    public var behind: Int
    public var changes: [Change]
    public var local_changes: Bool
    public var can_update: Bool
    public var reason: String?
    public var last_run: HubUpdateRun?
    public var running: Bool
}

public struct HubUpdateStarted: Decodable, Equatable, Sendable {
    public var started: Bool
    public var run: HubUpdateRun
}

extension HubClient {
    public func hubUpdate() async throws -> HubUpdateInfo { try await get("hub-update", as: HubUpdateInfo.self) }
    public func checkHubUpdate() async throws -> HubUpdateInfo { try await post("hub-update/check", Empty(), as: HubUpdateInfo.self) }
    public func startHubUpdate() async throws -> HubUpdateStarted { try await post("hub-update", Empty(), as: HubUpdateStarted.self) }
}

private struct Empty: Codable {}

/// Which app and version this is (CONTRACT, App updates): Settings, Devices and the assistant's update_apps show it,
/// and say how each device updates. `kind` is ios, ipados, macos or watchos; `build` the bundle's build number.
public struct AppReport: Codable, Equatable, Sendable {
    public var kind: String
    public var version: String
    public var build: String?

    public init(kind: String, version: String, build: String?) {
        self.kind = kind
        self.version = version
        self.build = build
    }

    /// This app, from its bundle, for a device of `platform`; nil when the bundle has no plain version (tests).
    public static func current(platform: Platform, info: [String: Any] = Bundle.main.infoDictionary ?? [:]) -> AppReport? {
        guard let version = info["CFBundleShortVersionString"] as? String,
              version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil else { return nil }
        let kind: String
        switch platform {
        case .watch: kind = "watchos"
        case .mac: kind = "macos"
        case .ipad: kind = "ipados"
        default: kind = "ios"
        }
        let build = (info["CFBundleVersion"] as? String).flatMap { $0.range(of: #"^[\w.-]{1,32}$"#, options: .regularExpression) != nil ? $0 : nil }
        return AppReport(kind: kind, version: version, build: build)
    }
}

extension HubClient {
    /// Says which app and version this is. Hubs before 1.0.5 answer 404, and the hub's main key 400: both are fine.
    public func reportApp(_ app: AppReport) async throws {
        _ = try await send("PUT", "devices/me/app", body: try JSONCoding.data(app))
    }
}
