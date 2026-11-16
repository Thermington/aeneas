import Foundation
#if canImport(Network) && !os(watchOS)
import Network
#endif

// The home route (CONTRACT.md, Devices, Home route, since 2026-11-16). Besides the address a device was paired with
// (Direct link or Tailscale), the hub answers on the home network over https with a certificate of its own, so devices
// at home keep syncing through it while the internet is down. On start, on waking, on a network change and after a
// request fails, the app asks the home addresses and the other route at the same time. It uses home when home answers
// within 1.5 seconds with the pinned certificate, else the other route. The device key goes to a home address only over
// a connection whose certificate matched the pin (checked during the TLS handshake, before any request is sent), and
// never over plain http. Bonjour is asked only when both fail, and never when the hub said it does not announce.
// The other route is always the address the device was set up with: what the hub answers never moves it elsewhere,
// and home ports come only from the addresses the hub lists, never worked out here.

/// The hub's own id: `hid` in setup links and `hub_id` from `/link/routes`, 26 characters of Crockford base32. Apps
/// tell one hub from another by it, not by the address it was reached at.
public enum HubID {
    public static let length = 26

    /// Uppercased, or nil when it is not a hub id.
    public static func normalize(_ raw: String?) -> String? {
        guard let s = raw?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(), s.count == length,
              s.allSatisfy({ PairingCode.alphabet.contains($0) }) else { return nil }
        return s
    }
}

/// `GET /link/routes`: the hub's id and the ways to reach it, kept from the last answer (`SharedConfig.linkRoutes`).
public struct LinkRoutes: Codable, Equatable, Sendable {
    public struct Home: Codable, Equatable, Sendable {
        /// The hub answers on the home network.
        public var on: Bool
        /// Its home network addresses now (`https://192.168.1.20:9787`), ports included.
        public var urls: [String]
        /// SHA-256 of the home certificate (DER), lowercase hex.
        public var fp: String?
        /// The hub announces itself by Bonjour.
        public var announce: Bool

        public init(on: Bool = true, urls: [String] = [], fp: String? = nil, announce: Bool = true) {
            self.on = on; self.urls = urls; self.fp = fp; self.announce = announce
        }

        /// Each field on its own: one missing leaves the home route off rather than losing the whole answer.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            on = (try? c.decodeIfPresent(Bool.self, forKey: .on)) ?? false
            urls = (try? c.decodeIfPresent([String].self, forKey: .urls)) ?? []
            fp = try? c.decodeIfPresent(String.self, forKey: .fp)
            announce = (try? c.decodeIfPresent(Bool.self, forKey: .announce)) ?? true
        }
    }

    public var hub_id: String?
    /// "direct", "tailscale" or "home".
    public var method: String?
    /// The address used away from home (Direct link or Tailscale); nil for a Home Wi-Fi only hub. Kept to show only:
    /// the device keeps using the address it was set up with, so this answer can never move it to another one.
    public var remote: String?
    public var home: Home?

    public init(hub_id: String? = nil, method: String? = nil, remote: String? = nil, home: Home? = nil) {
        self.hub_id = hub_id; self.method = method; self.remote = remote; self.home = home
    }
}

/// One way to the hub.
public struct HubRoute: Hashable, Sendable {
    public enum Kind: String, Sendable {
        case home, direct, tailscale
        /// Any other address (an older hub, a hub in development).
        case address
    }

    public var kind: Kind
    public var url: String
    /// The certificate this route must show. A home route always has one.
    public var pin: String?

    public init(kind: Kind, url: String, pin: String? = nil) {
        self.kind = kind; self.url = url; self.pin = pin
    }

    /// What Settings shows for the route in use; nil for any other address.
    public var label: String? {
        switch kind {
        case .home: return "Home network"
        case .direct: return "Direct link"
        case .tailscale: return "Tailscale"
        case .address: return nil
        }
    }
}

/// Picks the route requests take (`RoutedTransport`) and keeps it until a race says otherwise.
public final class RouteChooser: @unchecked Sendable {
    public typealias MakeTransport = @Sendable (_ route: HubRoute, _ key: String) -> HubTransport?
    public typealias Find = @Sendable (_ pin: String) async -> String?

    /// The routes this device's settings give.
    struct Plan: Equatable {
        /// The address the device was paired with, unless that is itself a home address (a Home Wi-Fi only hub).
        var remote: HubRoute?
        /// Home addresses: https with the hub's home certificate, nothing else.
        var home: [HubRoute] = []
        /// The route of the address the device was paired with.
        var address: HubRoute?
        /// The fingerprint Bonjour looks for when both fail. Nil when the hub does not announce or nothing is pinned.
        var findPin: String?
        /// A hub found by Bonjour moves the paired address too (that address is a home address).
        var addressIsHome = false
    }

    // Replaced in tests.
    var makeTransport: MakeTransport = { route, key in RouteChooser.standardTransport(route, key: key) }
    var find: Find = { pin in await HomeFinder.find(pin: pin) }
    /// How long home has to answer before the other route is used.
    var homeWait: TimeInterval = 1.5
    /// How long a home probe may take in all: a late answer still beats a route that is down.
    var homeProbeTimeout: TimeInterval = 4
    var remoteProbeTimeout: TimeInterval = 10
    /// Bonjour at most this often.
    var findInterval: TimeInterval = 60
    /// A network change is acted on once the network has been quiet this long.
    var settle: TimeInterval = 1
    /// After both routes failed, failed requests start no new race for this long.
    var quiet: TimeInterval = 5

    /// The route in use changed (any thread).
    public var onChange: (@Sendable (HubRoute?) -> Void)?
    /// Bonjour found the hub at a new home address, which showed the pinned certificate (any thread).
    public var onFound: (@Sendable (_ address: String, _ movesAddress: Bool) -> Void)?

    private let lock = NSLock()
    private var plan = Plan()
    private var chosen: HubRoute?
    private var racing: Task<HubRoute?, Never>?
    private var generation = 0
    /// Grows when the paired address or its pin changes: clients made before then send nothing more.
    private var _epoch = 0
    private var lastFailedRace: Date?
    private var lastFind: Date?
    private var probes: [HubRoute: HubTransport] = [:]
    private var monitor: AnyObject?
    private var pathSeen = false
    private var pathTick = 0

    public init() {}

    /// Whether the app's engine has given this its routes yet (an app woken in the background for the Watch may not have).
    public var hasRoutes: Bool { lock.withLock { plan.address != nil } }

    deinit {
        #if canImport(Network) && !os(watchOS)
        (monitor as? NWPathMonitor)?.cancel()
        #endif
    }

    // MARK: routes

    /// The routes for the address this device was paired with, its pin, and the hub's last answer to `/link/routes`.
    static func plan(address: String, pin: String?, routes: LinkRoutes?) -> Plan {
        let addr = address.trimmingCharacters(in: .whitespacesAndNewlines)
        let addressPin = HubPin.forHub(addr, pin: pin)
        let homeOnly = routes?.method == "home"
        var p = Plan()
        var home: [HubRoute] = []
        func addHome(_ url: String, _ pin: String?) {
            guard let r = homeRoute(url, pin: pin), !home.contains(where: { HomeFinder.sameAddress($0.url, r.url) }) else { return }
            home.append(r)
        }
        if homeOnly, let own = homeRoute(addr, pin: addressPin) {
            // A Home Wi-Fi only hub: the address it was paired with is a home address, and there is no other route.
            addHome(own.url, own.pin)
            p.address = own
            p.addressIsHome = true
        } else if HTTPTransport.hubURL(addr) != nil {
            let kind: HubRoute.Kind = DirectHub.isDirect(addr) ? .direct
                : (routes?.method == "tailscale" || Tailnet.isTailnetHub(addr)) ? .tailscale : .address
            p.remote = HubRoute(kind: kind, url: addr, pin: addressPin)
            p.address = p.remote
            // A hub that has not said its routes (an older one) at a pinned https address may be a Home Wi-Fi only hub.
            p.addressIsHome = routes == nil && addressPin != nil && kind == .address
        }
        if let h = routes?.home, h.on || homeOnly, let fp = HubPin.normalize(h.fp) {
            for u in h.urls.prefix(8) { addHome(u, fp) }
        }
        p.home = home
        if routes?.home?.announce != false {
            p.findPin = HubPin.normalize(routes?.home?.fp) ?? (p.addressIsHome ? addressPin : nil)
        }
        return p
    }

    /// A home address as a route: https with a valid pin, or nothing.
    static func homeRoute(_ url: String, pin: String?) -> HubRoute? {
        var s = url.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        guard let p = HubPin.normalize(pin), let u = URL(string: s), u.scheme?.lowercased() == "https", let h = u.host, !h.isEmpty else { return nil }
        return HubRoute(kind: .home, url: s, pin: p)
    }

    /// Takes this device's settings. True when the routes changed; the route in use is kept while it is still one of
    /// them. A new paired address or pin ends what clients made before could send.
    @discardableResult
    public func configure(address: String, pin: String?, routes: LinkRoutes?) -> Bool {
        let next = Self.plan(address: address, pin: pin, routes: routes)
        return lock.withLock {
            // A probe made now uses the hub connection as it is now (Tailscale signed in inside Aeneas, say).
            probes = [:]
            guard next != plan else { return false }
            if next.address?.url != plan.address?.url || next.address?.pin != plan.address?.pin { _epoch += 1 }
            plan = next
            if let c = chosen, !(next.home.contains(c) || next.remote == c) { chosen = nil }
            generation += 1
            racing?.cancel()
            racing = nil
            lastFailedRace = nil
            return true
        }
    }

    var epoch: Int { lock.withLock { _epoch } }

    /// The route in use, else the one requests start with: the paired address, or a Home Wi-Fi only hub's first address.
    public var current: HubRoute? { lock.withLock { chosen ?? plan.remote ?? plan.home.first } }

    /// The route of the address this device was paired with.
    var address: HubRoute? { lock.withLock { plan.address } }

    var hasHomeRoute: Bool { lock.withLock { !plan.home.isEmpty } }

    /// Tests: the route in use, set directly.
    func choose(_ r: HubRoute) { lock.withLock { chosen = r } }

    // MARK: choosing

    /// The route for a request: the one in use, else the outcome of a race (joined when one is running).
    func route() async -> HubRoute? {
        let (c, raceFirst) = lock.withLock { (chosen, chosen == nil && !plan.home.isEmpty) }
        if let c { return c }
        if raceFirst, let r = await race() { return r }
        return current
    }

    /// A request got no answer on `route`. Answers the route to try it on once more: the one a new race picks, or nil
    /// when that is no other.
    func failed(_ route: HubRoute) async -> HubRoute? {
        if Task.isCancelled { return nil }
        let (now, running, recent) = lock.withLock { (chosen ?? plan.remote ?? plan.home.first, racing, lastFailedRace) }
        // Another request moved to another route meanwhile.
        if let now, now != route { return now }
        if let running { return await running.value }
        // Both failed a moment ago: not a new race for each request that fails meanwhile.
        if let recent, Date().timeIntervalSince(recent) < quiet { return nil }
        return await race(after: route)
    }

    /// Race again in the background (start, waking); requests keep the route in use meanwhile.
    public func refresh() { refresh(fresh: false) }

    /// `fresh`: after a race already running ends (it may have started on the network as it was before).
    func refresh(fresh: Bool) {
        let (worth, running) = lock.withLock { (!plan.home.isEmpty, racing) }
        guard worth else { return }
        Task {
            if fresh, let running { _ = await running.value }
            await self.race()
        }
    }

    /// Ask the home addresses and the other route at the same time; the result is the route in use from then on.
    /// Nil when both failed (the route in use is kept, and Bonjour may look for the hub).
    @discardableResult
    func race(after failed: HubRoute? = nil) async -> HubRoute? {
        let task: Task<HubRoute?, Never> = lock.withLock {
            if let t = racing { return t }
            let gen = generation
            let t = Task { await self.runRace(generation: gen, after: failed) }
            racing = t
            return t
        }
        return await task.value
    }

    private func runRace(generation gen: Int, after failed: HubRoute?) async -> HubRoute? {
        let plan = lock.withLock { self.plan }
        var winner: HubRoute?
        if plan.home.isEmpty {
            // No home route: nothing to race. After a failure the paired address is asked once more.
            if let r = plan.remote {
                if failed == nil { winner = r } else if await probe(r, remoteProbeTimeout) { winner = r }
            }
        } else {
            winner = await contest(home: plan.home, remote: plan.remote)
        }
        var changed = false
        let current: Bool = lock.withLock {
            guard generation == gen else { return false }
            racing = nil
            if let winner {
                changed = chosen != winner
                chosen = winner
                lastFailedRace = nil
            } else {
                lastFailedRace = Date()
                // Requests keep trying the route they start with rather than waiting for a race each.
                if chosen == nil { chosen = plan.remote ?? plan.home.first }
            }
            return true
        }
        guard current else { return lock.withLock { chosen } }
        if let winner {
            if changed {
                HomeFinder.note("using the \(winner.kind.rawValue) route")
                onChange?(winner)
            }
        } else {
            lookForMovedHome(plan, generation: gen)
        }
        return winner
    }

    private enum Outcome: Sendable {
        case home(HubRoute, Bool)
        case remote(Bool)
        case window
    }

    /// Every home address and the other route at once. Home wins when it answers within `homeWait`; after that the
    /// other route wins once it answers. A later home answer still beats a route that is down.
    private func contest(home: [HubRoute], remote: HubRoute?) async -> HubRoute? {
        let (stream, cont) = AsyncStream.makeStream(of: Outcome.self)
        var tasks: [Task<Void, Never>] = []
        let homeTimeout = homeProbeTimeout, remoteTimeout = remoteProbeTimeout, wait = homeWait
        for h in home { tasks.append(Task { cont.yield(.home(h, await self.probe(h, homeTimeout))) }) }
        if let remote { tasks.append(Task { cont.yield(.remote(await self.probe(remote, remoteTimeout))) }) }
        tasks.append(Task {
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            cont.yield(.window)
        })
        defer {
            for t in tasks { t.cancel() }
            cont.finish()
        }
        var homeLeft = home.count
        var windowOpen = true
        // Nil while the other route has not answered yet; false when it failed or there is none.
        var remoteOK: Bool? = remote == nil ? false : nil
        var lateHome: HubRoute?
        for await o in stream {
            switch o {
            case .home(let h, let ok):
                homeLeft -= 1
                if ok {
                    if windowOpen || remoteOK == false { return h }
                    if lateHome == nil { lateHome = h }
                }
            case .remote(let ok):
                remoteOK = ok
            case .window:
                windowOpen = false
            }
            if remoteOK == true, !windowOpen || homeLeft == 0 { return remote }
            if remoteOK == false {
                if let lateHome { return lateHome }
                if homeLeft == 0 { return nil }
            }
        }
        return lateHome
    }

    /// `GET /health` with no key: whether the route answered in time. A home route's session accepts the pinned
    /// certificate only, checked during the TLS handshake, so a stand-in fails here before any request is sent.
    func probe(_ r: HubRoute, _ timeout: TimeInterval) async -> Bool {
        guard let t = probeTransport(r) else { return false }
        do {
            let (status, _) = try await withDeadline(timeout) { try await t.send(method: "GET", path: "health", query: [:], body: nil) }
            return (200..<300).contains(status)
        } catch {
            return false
        }
    }

    private func probeTransport(_ r: HubRoute) -> HubTransport? {
        if let t = lock.withLock({ probes[r] }) { return t }
        guard let t = makeTransport(r, "") else { return nil }
        lock.withLock { probes[r] = t }
        return t
    }

    /// Both routes failed: the hub may be at home under a new address (the router gave it one). Bonjour, at most once a
    /// minute, and what it finds is used only once the hub there showed the pinned certificate.
    private func lookForMovedHome(_ plan: Plan, generation gen: Int) {
        guard let pin = plan.findPin else { return }
        let go: Bool = lock.withLock {
            if let last = lastFind, Date().timeIntervalSince(last) < findInterval { return false }
            lastFind = Date()
            return true
        }
        guard go else { return }
        Task {
            guard let found = await self.find(pin), let route = Self.homeRoute(found, pin: pin) else { return }
            // The announcement only points the way: the hub there must show the pinned certificate.
            guard await self.probe(route, self.homeProbeTimeout) else {
                HomeFinder.note("the hub at its new address did not answer with its certificate")
                return
            }
            let taken: Bool = self.lock.withLock {
                guard self.generation == gen else { return false }
                if !self.plan.home.contains(route) { self.plan.home.insert(route, at: 0) }
                self.chosen = route
                self.lastFailedRace = nil
                return true
            }
            guard taken else { return }
            HomeFinder.note("the hub moved; using its new address")
            self.onFound?(route.url, plan.addressIsHome)
            self.onChange?(route)
        }
    }

    // MARK: network changes

    /// Races again after a network change (Wi-Fi joined or left, a VPN), once the network has been quiet a moment.
    public func watchNetwork() {
        #if canImport(Network) && !os(watchOS)
        lock.withLock {
            guard monitor == nil else { return }
            let m = NWPathMonitor()
            m.pathUpdateHandler = { [weak self] _ in self?.pathUpdated() }
            m.start(queue: DispatchQueue(label: "aeneas.routes.network"))
            monitor = m
        }
        #endif
    }

    private func pathUpdated() {
        // The first answer is the network as it is now, not a change.
        let first: Bool = lock.withLock {
            defer { pathSeen = true }
            return !pathSeen
        }
        if !first { networkChanged() }
    }

    /// The network changed: race again once it has been quiet for `settle` seconds.
    public func networkChanged() {
        let tick: Int = lock.withLock {
            pathTick += 1
            return pathTick
        }
        let wait = settle
        Task {
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard self.lock.withLock({ self.pathTick == tick }) else { return }
            self.refresh(fresh: true)
        }
    }

    /// A request failed on `route` and is not sent again: the routes are raced again in the background.
    func noteFailure(_ route: HubRoute) {
        Task { _ = await self.failed(route) }
    }

    // MARK: transports

    /// A request that got no answer on its route, as opposed to an answer the hub gave (a 404, say).
    static func isRouteFailure(_ error: Error) -> Bool { RouteFailure(error) != nil }

    /// The transport for a route and a key ("" for a probe). The paired address is made as the app always made it
    /// (Direct link, Tailscale inside Aeneas, https with its pin). A home address only over https with its pin,
    /// through the session that accepts that certificate and no other.
    public static func standardTransport(_ route: HubRoute, key: String) -> HubTransport? {
        guard route.kind == .home else { return HTTPTransport.make(urlString: route.url, token: key, pin: route.pin) }
        guard let r = homeRoute(route.url, pin: route.pin), let url = URL(string: r.url) else { return nil }
        return HTTPTransport(baseURL: url, token: key, pin: r.pin)
    }
}

/// Why a request got no answer on its route.
enum RouteFailure: Equatable {
    /// It cannot have reached the hub: no connection was made, or its certificate was refused during the handshake
    /// (a pin that did not match ends the request there, before anything is sent).
    case unsent
    /// It may have reached the hub: the connection broke or went quiet after it was sent.
    case unknown

    /// Nil for anything but a failure of the route: an answer from the hub, or a request its caller gave up on.
    init?(_ error: Error) {
        if error is CancellationError { return nil }
        if error is RouteUnavailable { self = .unsent; return }
        if let u = error as? URLError {
            self = Self.beforeSending.contains(u.code) ? .unsent : .unknown
            return
        }
        if let h = error as? HubError {
            guard case .transport = h else { return nil }
            self = .unknown
            return
        }
        // Any other failure of the connection: it may have gone out.
        self = .unknown
    }

    /// Failures that come before the request is sent. `cancelled` is a refused certificate here: a request its caller
    /// cancelled is never looked at.
    private static let beforeSending: Set<URLError.Code> = [
        .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .notConnectedToInternet, .internationalRoamingOff,
        .callIsActive, .dataNotAllowed, .secureConnectionFailed, .serverCertificateHasBadDate, .serverCertificateUntrusted,
        .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected,
        .clientCertificateRequired, .appTransportSecurityRequiresSecureConnection, .cancelled, .badURL, .unsupportedURL,
    ]
}

/// A route this device cannot use (no transport could be made for it): nothing was sent.
struct RouteUnavailable: Error {}

/// The app's own transport on the iPhone, iPad and Mac. Each request takes the route the chooser picked. One that gets
/// no answer there is sent once more on the route a new race picks, when that is another, and only when that repeats
/// nothing: it cannot have reached the hub, or sending it twice is harmless.
public final class RoutedTransport: HubTransport, @unchecked Sendable {
    public let chooser: RouteChooser
    private let key: String
    /// The chooser's epoch when this was made: after the paired address changes, this sends nothing more.
    private let epoch: Int
    private let lock = NSLock()
    private var made: [HubRoute: HubTransport] = [:]

    public init(chooser: RouteChooser, key: String) {
        self.chooser = chooser
        self.key = key
        self.epoch = chooser.epoch
    }

    /// The transport for a route with this client's key, made once. None once the paired address changed, so an old
    /// client never takes its key along routes to another hub.
    func transport(_ r: HubRoute) -> HubTransport? {
        guard chooser.epoch == epoch else { return nil }
        if let t = lock.withLock({ made[r] }) { return t }
        guard let t = chooser.makeTransport(r, key) else { return nil }
        lock.withLock { made[r] = t }
        return t
    }

    public func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        guard chooser.epoch == epoch else { throw HubError.transport("This connection to the hub was replaced.") }
        guard let first = await chooser.route() else { throw HubError.transport("This device has no way to reach the hub.") }
        do {
            return try await send(on: first, method: method, path: path, query: query, body: body)
        } catch {
            guard !Task.isCancelled, let failure = RouteFailure(error) else { throw Self.surface(error) }
            // A capture or an assistant message that may have arrived is never sent twice; the routes are raced
            // again all the same, for the requests after it.
            guard failure == .unsent || Self.repeatable(method: method, path: path) else {
                chooser.noteFailure(first)
                throw Self.surface(error)
            }
            guard let next = await chooser.failed(first), next != first else { throw Self.surface(error) }
            do {
                return try await send(on: next, method: method, path: path, query: query, body: body)
            } catch {
                throw Self.surface(error)
            }
        }
    }

    private func send(on r: HubRoute, method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        guard let t = transport(r) else { throw RouteUnavailable() }
        if let h = t as? HTTPTransport { return try await h.exchange(method: method, path: path, query: query, body: body) }
        return try await t.send(method: method, path: path, query: query, body: body)
    }

    /// Harmless to send twice: reading, replacing and deleting, and a push of patches (each field keeps the newer
    /// write, and a patch that changes nothing changes nothing). Any other POST, and PATCH, is not.
    static func repeatable(method: String, path: String) -> Bool {
        let p = path.hasPrefix("/") ? String(path.dropFirst()) : path
        switch method.uppercased() {
        case "GET", "PUT", "DELETE": return true
        case "POST": return p == "sync/push"
        default: return false
        }
    }

    /// What callers see of a failed route: `HubError.transport`, as from a plain HTTP transport.
    static func surface(_ error: Error) -> Error {
        if error is RouteUnavailable { return HubError.transport("This device cannot use that way to the hub.") }
        if error is HubError || error is CancellationError { return error }
        return HubError.transport(error.localizedDescription)
    }

    /// The route in use as HTTP, for the live stream and streamed replies.
    public var currentHTTP: HTTPTransport? { chooser.current.flatMap { transport($0) as? HTTPTransport } }

    /// The address this device was paired with as HTTP (a sign-in return address, the sensors how-to).
    public var addressHTTP: HTTPTransport? { chooser.address.flatMap { transport($0) as? HTTPTransport } }
}

extension HubClient {
    /// `GET /link/routes`: the hub's id and the ways to reach it. Paired apps ask on every connect.
    public func linkRoutes() async throws -> LinkRoutes { try await get("link/routes", as: LinkRoutes.self) }

    /// The app's own client on the iPhone, iPad and Mac: the address it was paired with and, when the hub has one, its
    /// home network route, picked by `routes`. Nil when there is no hub address.
    public static func routed(config: SharedConfig, routes: RouteChooser) -> HubClient? {
        guard HTTPTransport.hubURL(config.hubURL) != nil else { return nil }
        #if DEBUG
        // `-EARecordSample YES` keeps every answer through one plain transport (HubClient.make).
        if UserDefaults.standard.bool(forKey: "EARecordSample") { return nil }
        #endif
        if routes.configure(address: config.hubURL, pin: config.hubPin, routes: config.linkRoutes) { routes.refresh() }
        return HubClient(transport: RoutedTransport(chooser: routes, key: config.credential))
    }
}
