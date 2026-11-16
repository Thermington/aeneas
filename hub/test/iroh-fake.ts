/**
 * iroh as loaded, with no relay anywhere (whatever the hub asks for, so nothing leaves this machine) and the relay's
 * answer in the test's hands: `online()` waits until the test calls `answer()`, and the endpoint names `url` as its
 * relay from then on. Everything else is the real iroh.
 */
export function relayInTestHands(url: string) {
  let answer!: () => void;
  const answered = new Promise<void>((r) => { answer = r; });
  let online = false;
  const load = async () => {
    const real = await import("@number0/iroh");
    const RelayMode = { disabled: () => real.RelayMode.disabled(), defaultMode: () => real.RelayMode.disabled(), customFromUrls: () => real.RelayMode.disabled() };
    const Endpoint = {
      builder: () => {
        const b = real.Endpoint.builder();
        const bind = b.bind.bind(b);
        return Object.assign(b, {
          bind: async () => {
            const ep = await bind();
            const addr = ep.addr.bind(ep);
            return Object.assign(ep, {
              online: () => answered.then(() => { online = true; }),
              addr: () => Object.assign(addr(), { relayUrl: () => (online ? url : null) }),
            });
          },
        });
      },
    };
    return { ...real, RelayMode, Endpoint } as unknown as typeof real;
  };
  return { load, answer: () => answer() };
}
