import XCTest
@testable import EACore

/// A test network for the route chooser: how each address answers, and every request that reached one.
final class TestNet: @unchecked Sendable {
    struct Call: Equatable {
        var url: String
        var key: String
        var method: String
        var path: String
    }

    struct Spot {
        var delay: TimeInterval = 0
        /// No connection at all (out of reach, or a certificate the pinned session refused during the handshake):
        /// the request never left.
        var down = false
        /// The request reached the hub, which took it, and the answer was lost on the way back.
        var lost = false
        var status = 200
        /// The hub behind this address: requests other than `/health` and `/link/routes` go to it.
        var hub: HubTransport?
        /// What `/link/routes` answers here.
        var routes: LinkRoutes?
    }

    private let lock = NSLock()
    private var spots: [String: Spot] = [:]
    private var log: [Call] = []

    subscript(url: String) -> Spot {
        get { lock.withLock { spots[url] ?? Spot() } }
        set { lock.withLock { spots[url] = newValue } }
    }

    var calls: [Call] { lock.withLock { log } }
    func calls(to url: String) -> [Call] { calls.filter { $0.url == url } }
    /// Requests that carried a key (probes carry none).
    func keyed(_ url: String) -> [Call] { calls(to: url).filter { !$0.key.isEmpty } }
    func probes(_ url: String) -> [Call] { calls(to: url).filter { $0.path == "health" } }

    func transport(_ route: HubRoute, _ key: String) -> HubTransport? { NetTransport(net: self, url: route.url, key: key) }

    fileprivate func note(_ c: Call) { lock.withLock { log.append(c) } }
}

final class NetTransport: HubTransport, @unchecked Sendable {
    let net: TestNet
    let url: String
    let key: String

    init(net: TestNet, url: String, key: String) { self.net = net; self.url = url; self.key = key }

    func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        let spot = net[url]
        // Every attempt is noted, made or not.
        net.note(.init(url: url, key: key, method: method, path: path))
        if spot.down { throw URLError(.cannotConnectToHost) }
        if spot.delay > 0 { try await Task.sleep(nanoseconds: UInt64(spot.delay * 1_000_000_000)) }
        if spot.lost {
            if path != "health", let hub = spot.hub { _ = try? await hub.send(method: method, path: path, query: query, body: body) }
            throw URLError(.networkConnectionLost)
        }
        if path == "health" { return (spot.status, Data(#"{"ok":true}"#.utf8)) }
        if path == "link/routes", let r = spot.routes { return (200, try JSONCoding.data(r)) }
        if let hub = spot.hub { return try await hub.send(method: method, path: path, query: query, body: body) }
        return (spot.status, Data("{}".utf8))
    }
}

/// Lines noted from any thread.
final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []
    func add(_ s: String) { lock.withLock { lines.append(s) } }
    var all: [String] { lock.withLock { lines } }
}

/// What Bonjour was asked, and what it answers.
final class FakeFinder: @unchecked Sendable {
    private let asked = Recorder()
    var answer: String?
    var pins: [String] { asked.all }
    func find(_ pin: String) async -> String? {
        asked.add(pin)
        return answer
    }
}

/// Waits up to `timeout` seconds for `ok`.
func eventually(_ timeout: TimeInterval = 3, _ ok: () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if ok() { return true }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return ok()
}

/// Choosing between the home network and the other route (CONTRACT.md, Devices, Home route).
final class RouteChooserTests: XCTestCase {
    static let hubId = "01JD5Q8R3K7V2M9N4P6T0W1X2Y"
    static let fp = String(repeating: "ab", count: 32)
    let remote = "https://hub.example.ts.net"
    let home = "https://192.168.1.20:9787"

    private func routes(urls: [String]? = nil, fp: String? = RouteChooserTests.fp, on: Bool = true, announce: Bool = true) -> LinkRoutes {
        LinkRoutes(hub_id: Self.hubId, method: "tailscale", remote: remote, home: .init(on: on, urls: urls ?? [home], fp: fp, announce: announce))
    }

    private func chooser(_ net: TestNet, routes: LinkRoutes?, finder: FakeFinder? = nil) -> RouteChooser {
        let c = RouteChooser()
        c.makeTransport = { r, k in net.transport(r, k) }
        let f = finder ?? FakeFinder()
        c.find = { pin in await f.find(pin) }
        c.homeWait = 0.3
        c.homeProbeTimeout = 2
        c.remoteProbeTimeout = 2
        c.settle = 0.05
        c.quiet = 0.5
        c.configure(address: remote, pin: nil, routes: routes)
        return c
    }

    private func get(_ t: RoutedTransport, _ path: String = "sync/changes") async throws -> Int {
        try await t.send(method: "GET", path: path, query: [:], body: nil).status
    }

    private func expect(_ status: Int, _ t: RoutedTransport, _ path: String = "sync/changes", _ message: String = "",
                        file: StaticString = #filePath, line: UInt = #line) async throws {
        let got = try await get(t, path)
        XCTAssertEqual(got, status, message, file: file, line: line)
    }

    // MARK: the race

    func testHomeThatAnswersInTimeIsUsed() async throws {
        let net = TestNet()
        net[remote] = .init(delay: 0.01)
        net[home] = .init(delay: 0.1)
        let c = chooser(net, routes: routes())
        let t = RoutedTransport(chooser: c, key: "ead1_k")
        try await expect(200, t)
        XCTAssertEqual(c.current, HubRoute(kind: .home, url: home, pin: Self.fp))
        XCTAssertEqual(net.keyed(home).map(\.path), ["sync/changes"], "the request went home")
        XCTAssertTrue(net.keyed(remote).isEmpty)
        XCTAssertFalse(net.probes(home).isEmpty)
        XCTAssertTrue(net.probes(home).allSatisfy { $0.key.isEmpty }, "a probe carries no key")
        XCTAssertTrue(net.probes(remote).allSatisfy { $0.key.isEmpty })
    }

    func testASlowHomeLosesToTheOtherRoute() async throws {
        let net = TestNet()
        net[remote] = .init(delay: 0.01)
        net[home] = .init(delay: 1.2)
        let c = chooser(net, routes: routes())
        let start = Date()
        let r = await c.route()
        XCTAssertEqual(r?.kind, .tailscale)
        XCTAssertLessThan(Date().timeIntervalSince(start), 1.0, "the other route did not wait for a slow home")
        let t = RoutedTransport(chooser: c, key: "ead1_k")
        try await expect(200, t)
        XCTAssertEqual(net.keyed(remote).count, 1)
        XCTAssertTrue(net.keyed(home).isEmpty)
    }

    /// A home address answered by anything but the hub's own certificate: the pinned session refuses it during the
    /// handshake, which the test network shows as no answer. The key never goes there.
    func testAHomeAddressWithAnotherCertificateIsNeverUsed() async throws {
        let net = TestNet()
        net[remote] = .init(delay: 0.05)
        net[home] = .init(down: true)
        let c = chooser(net, routes: routes())
        let t = RoutedTransport(chooser: c, key: "ead1_k")
        try await expect(200, t)
        XCTAssertEqual(c.current?.kind, .tailscale)
        XCTAssertTrue(net.keyed(home).isEmpty, "the key never went to the stand-in")
    }

    /// The other route is down (the internet is out): home is used even when it answers after the 1.5 seconds.
    func testWithTheOtherRouteDownALateHomeStillServes() async {
        let net = TestNet()
        net[remote] = .init(down: true)
        net[home] = .init(delay: 0.6)
        let c = chooser(net, routes: routes())
        let r = await c.route()
        XCTAssertEqual(r?.kind, .home)
    }

    func testWithoutAHomeRouteNothingIsRaced() async throws {
        let net = TestNet()
        net[remote] = .init()
        let c = chooser(net, routes: nil)
        let t = RoutedTransport(chooser: c, key: "ead1_k")
        try await expect(200, t)
        XCTAssertTrue(net.calls.allSatisfy { $0.path != "health" }, "no probe at all")
        XCTAssertEqual(net.keyed(remote).count, 1)
        // The home route switched off on the hub: the same.
        let off = TestNet()
        off[remote] = .init()
        let c2 = chooser(off, routes: routes(on: false))
        try await expect(200, RoutedTransport(chooser: c2, key: "ead1_k"))
        XCTAssertTrue(off.calls(to: home).isEmpty)
    }

    // MARK: a failed request

    func testAFailedRequestIsTriedOnceOnTheOtherRoute() async throws {
        let net = TestNet()
        net[remote] = .init()
        net[home] = .init()
        let c = chooser(net, routes: routes())
        let t = RoutedTransport(chooser: c, key: "ead1_k")
        try await expect(200, t)
        XCTAssertEqual(c.current?.kind, .home)
        // Left home: the request fails there, a race picks the other route, and it is sent there once.
        net[home] = .init(down: true)
        try await expect(200, t, "sync/push")
        XCTAssertEqual(net.keyed(home).map(\.path), ["sync/changes", "sync/push"])
        XCTAssertEqual(net.keyed(remote).map(\.path), ["sync/push"])
        XCTAssertEqual(c.current?.kind, .tailscale)
        // Both down: the request fails after one try on the route in use, with no third.
        net[remote] = .init(down: true)
        let before = net.calls.filter { !$0.key.isEmpty }.count
        do {
            _ = try await get(t, "entities")
            XCTFail("nothing answers")
        } catch {
            XCTAssertTrue(RouteChooser.isRouteFailure(error))
        }
        XCTAssertEqual(net.calls.filter { !$0.key.isEmpty }.count - before, 1, "tried once on the route in use; no other answered")
        // Within a moment of that, another failed request starts no new race.
        let probesBefore = net.calls.filter { $0.path == "health" }.count
        _ = try? await get(t, "entities")
        XCTAssertEqual(net.calls.filter { $0.path == "health" }.count, probesBefore)
    }

    /// At home on the other route (home was slow to answer at first), then the internet goes out: the request that
    /// fails there goes home, and later ones stay home.
    func testWhenTheInternetGoesOutARequestMovesHome() async throws {
        let net = TestNet()
        net[remote] = .init()
        net[home] = .init(delay: 1.2)
        let c = chooser(net, routes: routes())
        let t = RoutedTransport(chooser: c, key: "ead1_k")
        try await expect(200, t)
        XCTAssertEqual(c.current?.kind, .tailscale)
        net[remote] = .init(down: true)
        net[home] = .init()
        try await expect(200, t, "sync/push")
        try await expect(200, t, "sync/changes")
        XCTAssertEqual(net.keyed(remote).map(\.path), ["sync/changes", "sync/push"])
        XCTAssertEqual(net.keyed(home).map(\.path), ["sync/push", "sync/changes"])
        XCTAssertEqual(c.current?.kind, .home)
    }

    // MARK: what is sent twice

    private func send(_ t: RoutedTransport, _ path: String, method: String = "POST") async -> Bool {
        (try? await t.send(method: method, path: path, query: [:], body: Data("{}".utf8))) != nil
    }

    /// The hub took the request and its answer was lost on the way back. A capture or an assistant message is never
    /// sent a second time; the routes are raced again for what comes after.
    func testAPostThatMayHaveArrivedIsNeverSentTwice() async throws {
        for path in ["capture", "ai/chat"] {
            let net = TestNet()
            net[remote] = .init()
            net[home] = .init()
            let c = chooser(net, routes: routes())
            let t = RoutedTransport(chooser: c, key: "ead1_k")
            try await expect(200, t)
            XCTAssertEqual(c.current?.kind, .home)
            net[home] = .init(lost: true)
            let ok = await send(t, path)
            XCTAssertFalse(ok, path)
            XCTAssertEqual(net.keyed(home).filter { $0.path == path }.count, 1, path)
            XCTAssertTrue(net.keyed(remote).filter { $0.path == path }.isEmpty, "\(path) is not sent a second time")
            let moved = await eventually { c.current?.kind == .tailscale }
            XCTAssertTrue(moved, "the routes were raced again for the next request")
        }
    }

    /// No connection could be made (or the certificate was refused during the handshake): nothing reached the hub, so
    /// even a capture goes once on the other route.
    func testAPostThatNeverLeftGoesOnTheOtherRoute() async throws {
        let net = TestNet()
        net[remote] = .init()
        net[home] = .init()
        let c = chooser(net, routes: routes())
        let t = RoutedTransport(chooser: c, key: "ead1_k")
        try await expect(200, t)
        net[home] = .init(down: true)
        let ok = await send(t, "capture")
        XCTAssertTrue(ok)
        XCTAssertEqual(net.keyed(remote).map(\.path), ["capture"])
    }

    func testOnlyRepeatableRequestsAreSentAgainWhenTheirAnswerWasLost() async throws {
        let cases: [(String, String, Bool)] = [
            ("GET", "entities", true), ("PUT", "vault/file", true), ("DELETE", "entities/n1", true), ("POST", "sync/push", true),
            ("PATCH", "entities/n1", false), ("POST", "capture", false), ("POST", "ai/chat", false),
        ]
        for (method, path, again) in cases {
            let net = TestNet()
            net[remote] = .init()
            net[home] = .init()
            let c = chooser(net, routes: routes())
            let t = RoutedTransport(chooser: c, key: "ead1_k")
            try await expect(200, t)
            net[home] = .init(lost: true)
            let ok = await send(t, path, method: method)
            XCTAssertEqual(ok, again, "\(method) \(path)")
            XCTAssertEqual(net.keyed(remote).filter { $0.path == path }.count, again ? 1 : 0, "\(method) \(path)")
        }
        XCTAssertTrue(RoutedTransport.repeatable(method: "post", path: "/sync/push"))
    }

    func testWhatCountsAsNeverSent() {
        XCTAssertEqual(RouteFailure(URLError(.cannotConnectToHost)), .unsent)
        XCTAssertEqual(RouteFailure(URLError(.notConnectedToInternet)), .unsent)
        XCTAssertEqual(RouteFailure(URLError(.serverCertificateUntrusted)), .unsent)
        XCTAssertEqual(RouteFailure(URLError(.cancelled)), .unsent, "the pinned session refused the certificate")
        XCTAssertEqual(RouteFailure(RouteUnavailable()), .unsent)
        XCTAssertEqual(RouteFailure(URLError(.timedOut)), .unknown, "it may have gone out before the wait ran out")
        XCTAssertEqual(RouteFailure(URLError(.networkConnectionLost)), .unknown)
        XCTAssertEqual(RouteFailure(HubError.transport("The request timed out.")), .unknown)
        XCTAssertNil(RouteFailure(HubError.http(status: 500, message: "")), "the hub answered")
        XCTAssertNil(RouteFailure(CancellationError()))
        XCTAssertEqual(RouteFailure(NSError(domain: "SomeConnection", code: 7)), .unknown, "any other failure may have gone out")
        // Callers see the same kind of error as from a plain HTTP transport.
        XCTAssertEqual(RoutedTransport.surface(URLError(.cannotConnectToHost)) as? HubError, .transport(URLError(.cannotConnectToHost).localizedDescription))
    }

    func testAnAnswerFromTheHubIsNotTriedElsewhere() async throws {
        let net = TestNet()
        net[remote] = .init()
        net[home] = .init()
        let c = chooser(net, routes: routes())
        let t = RoutedTransport(chooser: c, key: "ead1_k")
        _ = try await get(t)
        var spot = net[home]
        spot.status = 500
        net[home] = spot
        try await expect(500, t, "entities", "the hub answered: that answer stands")
        XCTAssertTrue(net.keyed(remote).isEmpty)
    }

    func testACancelledRequestStartsNoRace() async throws {
        let net = TestNet()
        net[remote] = .init(delay: 2)
        let c = chooser(net, routes: nil)
        let t = RoutedTransport(chooser: c, key: "ead1_k")
        let task = Task { try await t.send(method: "GET", path: "entities", query: [:], body: nil) }
        try await Task.sleep(nanoseconds: 100_000_000)
        task.cancel()
        _ = try? await task.value
        XCTAssertTrue(net.probes(remote).isEmpty, "the caller gave up: the route did not fail")
    }

    // MARK: racing again

    func testStartWakingAndNetworkChangesRaceAgain() async {
        let net = TestNet()
        net[remote] = .init()
        net[home] = .init(down: true)
        let c = chooser(net, routes: routes())
        let first = await c.route()
        XCTAssertEqual(first?.kind, .tailscale)
        // Back home (start or waking): a race in the background moves to home.
        net[home] = .init()
        c.refresh()
        let movedHome = await eventually { c.current?.kind == .home }
        XCTAssertTrue(movedHome)
        // Wi-Fi left: the network change races again once it settles.
        net[home] = .init(down: true)
        c.networkChanged()
        let movedAway = await eventually { c.current?.kind == .tailscale }
        XCTAssertTrue(movedAway)
    }

    func testAChangeOfRouteIsReported() async {
        let net = TestNet()
        net[remote] = .init()
        net[home] = .init()
        let c = chooser(net, routes: routes())
        let seen = Recorder()
        c.onChange = { r in seen.add(r?.kind.rawValue ?? "none") }
        _ = await c.route()
        let told = await eventually { seen.all == ["home"] }
        XCTAssertTrue(told, "\(seen.all)")
    }

    // MARK: never home without a pin

    func testNeverHomeOverHTTPOrWithoutAPin() async throws {
        let fp = Self.fp
        let mixed = RouteChooser.plan(address: remote, pin: nil, routes: routes(urls: ["http://192.168.1.20:9787", home, "192.168.1.21:9787"]))
        XCTAssertEqual(mixed.home.map(\.url), [home], "only https home addresses")
        XCTAssertTrue(RouteChooser.plan(address: remote, pin: nil, routes: routes(fp: nil)).home.isEmpty, "no certificate to pin: no home route")
        XCTAssertTrue(RouteChooser.plan(address: remote, pin: nil, routes: routes(fp: "nonsense")).home.isEmpty)
        XCTAssertNil(RouteChooser.standardTransport(HubRoute(kind: .home, url: "http://192.168.1.20:9787", pin: fp), key: "k"))
        XCTAssertNil(RouteChooser.standardTransport(HubRoute(kind: .home, url: home, pin: nil), key: "k"))
        // A home address goes only through the session that checks the pin during the handshake.
        let t = try XCTUnwrap(RouteChooser.standardTransport(HubRoute(kind: .home, url: home, pin: fp), key: "ead1_k") as? HTTPTransport)
        XCTAssertEqual((t.session.delegate as? PinnedSessionDelegate)?.pin, fp)
        XCTAssertEqual(t.token, "ead1_k")
        XCTAssertEqual(t.baseURL.absoluteString, home)
        // Only plain http addresses offered: nothing is ever sent to them.
        let net = TestNet()
        net[remote] = .init()
        let c = chooser(net, routes: routes(urls: ["http://192.168.1.20:9787"]))
        try await expect(200, RoutedTransport(chooser: c, key: "ead1_k"))
        XCTAssertTrue(net.calls(to: "http://192.168.1.20:9787").isEmpty)
    }

    func testPinnedSessionsNeverFollowARedirect() async throws {
        let d = PinnedSessionDelegate(pin: Self.fp)
        let from = try XCTUnwrap(URL(string: home + "/sync/changes"))
        let to = URLRequest(url: try XCTUnwrap(URL(string: "http://elsewhere.test/collect")))
        let answer = try XCTUnwrap(HTTPURLResponse(url: from, statusCode: 302, httpVersion: nil, headerFields: ["Location": "http://elsewhere.test/collect"]))
        let task = URLSession(configuration: .ephemeral).dataTask(with: from)
        let next = await d.urlSession(URLSession.shared, task: task, willPerformHTTPRedirection: answer, newRequest: to)
        XCTAssertNil(next, "the key does not follow a redirect")
    }

    // MARK: what the routes are

    func testTheRoutesOfEachKindOfHub() {
        let fp = Self.fp
        let node = String(repeating: "c", count: 64)
        let direct = DirectHub.address(node: node, relay: "https://relay.example")
        let d = RouteChooser.plan(address: direct, pin: nil, routes: LinkRoutes(hub_id: Self.hubId, method: "direct", remote: direct, home: .init(on: true, urls: [home], fp: fp)))
        XCTAssertEqual(d.remote?.kind, .direct)
        XCTAssertEqual(d.home.map(\.url), [home])
        XCTAssertEqual(d.findPin, fp)
        XCTAssertFalse(d.addressIsHome)
        XCTAssertEqual(RouteChooser.plan(address: remote, pin: nil, routes: nil).remote?.kind, .tailscale)
        XCTAssertNil(RouteChooser.plan(address: remote, pin: nil, routes: nil).findPin, "nothing pinned, no home route: no Bonjour")
        // A Home Wi-Fi only hub: its own address is a home address, and there is no other route.
        let h = RouteChooser.plan(address: home, pin: fp, routes: LinkRoutes(hub_id: Self.hubId, method: "home", remote: nil,
                                                                            home: .init(on: true, urls: [home + "/", "https://[fe80::1%25en0]:9787"], fp: fp)))
        XCTAssertNil(h.remote)
        XCTAssertEqual(h.home.count, 2, "its own address once")
        XCTAssertEqual(h.address?.kind, .home)
        XCTAssertTrue(h.addressIsHome)
        XCTAssertEqual(h.findPin, fp)
        // An older hub that has not said its routes, at a pinned https address: Bonjour may find it when it moves.
        let older = RouteChooser.plan(address: home, pin: fp, routes: nil)
        XCTAssertEqual(older.remote?.kind, .address)
        XCTAssertTrue(older.addressIsHome)
        XCTAssertEqual(older.findPin, fp)
        // Announcing switched off on the hub: no Bonjour.
        XCTAssertNil(RouteChooser.plan(address: remote, pin: nil, routes: routes(announce: false)).findPin)
        XCTAssertEqual([HubRoute.Kind.home, .direct, .tailscale, .address].map { HubRoute(kind: $0, url: "x").label },
                       ["Home network", "Direct link", "Tailscale", nil])
    }

    func testTheRoutesAnswerDecodes() throws {
        let full = try JSONCoding.decode(LinkRoutes.self, from: #"{"hub_id":"01jd5q8r3k7v2m9n4p6t0w1x2y","method":"tailscale","remote":"https://hub.example.ts.net","home":{"on":true,"urls":["https://192.168.1.20:9787"],"fp":"\#(Self.fp)","announce":false}}"#)
        XCTAssertEqual(HubID.normalize(full.hub_id), Self.hubId)
        XCTAssertEqual(full.method, "tailscale")
        XCTAssertEqual(full.home, .init(on: true, urls: [home], fp: Self.fp, announce: false))
        let homeOnly = try JSONCoding.decode(LinkRoutes.self, from: #"{"hub_id":"x","method":"home","remote":null,"home":{"urls":["https://192.168.1.20:9787"]}}"#)
        XCTAssertNil(homeOnly.remote)
        XCTAssertEqual(homeOnly.home?.on, false, "a home route not said to be on is off")
        XCTAssertEqual(homeOnly.home?.announce, true)
        XCTAssertNil(homeOnly.home?.fp)
        let empty = try JSONCoding.decode(LinkRoutes.self, from: "{}")
        XCTAssertNil(empty.hub_id)
        XCTAssertNil(empty.home)
        // Kept as it came.
        XCTAssertEqual(try JSONCoding.decode(LinkRoutes.self, from: try JSONCoding.data(full)), full)
    }

    // MARK: Bonjour

    func testBonjourIsAskedOnlyWhenBothFail() async {
        let finder = FakeFinder()
        let net = TestNet()
        net[remote] = .init()
        net[home] = .init(down: true)
        let c = chooser(net, routes: routes(), finder: finder)
        _ = await c.race()
        net[remote] = .init(down: true)
        net[home] = .init()
        _ = await c.race()
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(finder.pins, [], "one route answered each time")
        net[home] = .init(down: true)
        let none = await c.race()
        XCTAssertNil(none)
        let asked = await eventually { finder.pins == [Self.fp] }
        XCTAssertTrue(asked, "both failed: Bonjour looks for the home certificate")
        _ = await c.race()
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(finder.pins.count, 1, "at most once a minute")
    }

    func testAnAddressBonjourFoundIsTakenOnlyWithThePinnedCertificate() async throws {
        let moved = "https://192.168.1.30:9787"
        let finder = FakeFinder()
        finder.answer = moved
        let net = TestNet()
        net[remote] = .init(down: true)
        net[home] = .init(down: true)
        // What answers at the announced address does not show the pinned certificate.
        net[moved] = .init(down: true)
        let c = chooser(net, routes: routes(), finder: finder)
        _ = await c.race()
        _ = await eventually { finder.pins.count == 1 }
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertNotEqual(c.current?.url, moved)
        XCTAssertTrue(net.keyed(moved).isEmpty)

        // The hub itself, under its new address.
        let net2 = TestNet()
        net2[remote] = .init(down: true)
        net2[home] = .init(down: true)
        net2[moved] = .init()
        let found = Recorder()
        let c2 = chooser(net2, routes: routes(), finder: finder)
        c2.onFound = { address, moves in found.add("\(address) \(moves)") }
        _ = await c2.race()
        let taken = await eventually { c2.current?.url == moved }
        XCTAssertTrue(taken)
        XCTAssertEqual(c2.current?.kind, .home)
        let told = await eventually { found.all == ["\(moved) false"] }
        XCTAssertTrue(told, "a Tailscale hub's paired address stays as it is: \(found.all)")
        let t = RoutedTransport(chooser: c2, key: "ead1_k")
        try await expect(200, t)
        XCTAssertEqual(net2.keyed(moved).count, 1)

        // Bonjour pointing at plain http: never asked at all.
        let net3 = TestNet()
        net3[remote] = .init(down: true)
        net3[home] = .init(down: true)
        let plain = FakeFinder()
        plain.answer = "http://192.168.1.30:9787"
        let c3 = chooser(net3, routes: routes(), finder: plain)
        _ = await c3.race()
        _ = await eventually { plain.pins.count == 1 }
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertTrue(net3.calls(to: "http://192.168.1.30:9787").isEmpty)
    }

    // MARK: clients and streams

    /// After the paired address changes (another hub), a client made before sends nothing more: its key never goes
    /// along the new hub's routes.
    func testAnOldClientSendsNothingOnceTheAddressChanged() async throws {
        let net = TestNet()
        net[remote] = .init()
        net["https://other.example"] = .init()
        let c = chooser(net, routes: nil)
        let old = RoutedTransport(chooser: c, key: "ead1_old")
        try await expect(200, old)
        c.configure(address: "https://other.example", pin: nil, routes: nil)
        do {
            _ = try await get(old)
            XCTFail("an old client is done")
        } catch {}
        XCTAssertTrue(net.calls(to: "https://other.example").isEmpty)
        // The same address with home addresses learned is the same hub: a client made before carries on.
        let same = RoutedTransport(chooser: c, key: "ead1_new")
        c.configure(address: "https://other.example", pin: nil, routes: routes())
        try await expect(200, same)
    }

    func testStreamsGoOverTheRouteInUse() throws {
        let c = RouteChooser()
        c.configure(address: remote, pin: nil, routes: routes())
        let client = HubClient(transport: RoutedTransport(chooser: c, key: "ead1_k"))
        XCTAssertEqual(client.http?.baseURL.absoluteString, remote, "links a browser opens use the paired address")
        XCTAssertTrue(client.supportsStreaming)
        XCTAssertEqual(client.streamHTTP?.baseURL.absoluteString, remote)
        c.choose(HubRoute(kind: .home, url: home, pin: Self.fp))
        let s = try XCTUnwrap(client.streamHTTP)
        XCTAssertEqual(s.baseURL.absoluteString, home)
        XCTAssertEqual((s.session.delegate as? PinnedSessionDelegate)?.pin, Self.fp, "the live stream at home is pinned too")
        XCTAssertEqual(s.token, "ead1_k")
    }
}
