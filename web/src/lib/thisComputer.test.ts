import { describe, expect, it } from "vitest";
import { accessScript, keyValues } from "./thisComputer";

describe("this computer", () => {
  it("reads key=value lines, several of one key in order", () => {
    expect(keyValues("hostkey=ssh-ed25519 AAA host\r\nhostkey=ecdsa-sha2-nistp256 BBB\r\nok=1\r\nuser=alex\r\nname=DESK-PC\r\nnoise")).toEqual({
      hostkey: ["ssh-ed25519 AAA host", "ecdsa-sha2-nistp256 BBB"], ok: ["1"], user: ["alex"], name: ["DESK-PC"],
    });
  });

  it("puts the hub's key in both parts and keeps the elevated part inside one here-string", () => {
    const s = accessScript("ssh-ed25519 AAAAkey aeneas-hub@server");
    expect(s.match(/\$k = 'ssh-ed25519 AAAAkey aeneas-hub@server'/g)).toHaveLength(2);
    const lines = s.split("\n");
    // A line starting with '@ ends the here-string: only the one closing it may.
    expect(lines.filter((l) => l.startsWith("'@"))).toEqual(["'@"]);
    expect(s).toContain("-Verb RunAs");
    expect(s).toContain("administrators_authorized_keys");
    expect(accessScript("ssh-ed25519 AAAA'; Remove-Item C:\\ -Recurse; '")).not.toContain("'; Remove-Item");
  });
});
