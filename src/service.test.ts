import { describe, it, expect } from "bun:test";
import { createServer } from "node:net";

import {
  generatePlistContent,
  generateSystemdUnitContent,
  isPortInUse,
  waitForPort,
  LAUNCH_LABEL,
  SYSTEMD_UNIT_NAME,
} from "./service";

const BUN_CMD = ["/usr/local/bin/bun", "run", "/opt/3router/dist/cli.js", "serve"];
const NODE_CMD = ["/usr/local/bin/node", "/opt/3router/dist/cli.js", "serve"];

describe("generatePlistContent", () => {
  it("generates valid XML with correct label", () => {
    const plist = generatePlistContent(BUN_CMD, "/tmp/logs");
    expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(plist).toContain(`<key>Label</key>`);
    expect(plist).toContain(`<string>${LAUNCH_LABEL}</string>`);
  });

  it("includes ProgramArguments as provided argv (bun)", () => {
    const plist = generatePlistContent(BUN_CMD, "/home/user/.3router/logs");
    expect(plist).toContain("<string>/usr/local/bin/bun</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<string>/opt/3router/dist/cli.js</string>");
    expect(plist).toContain("<string>serve</string>");
  });

  it("includes ProgramArguments as provided argv (node)", () => {
    const plist = generatePlistContent(NODE_CMD, "/home/user/.3router/logs");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).not.toContain("<string>run</string>");
    expect(plist).toContain("<string>serve</string>");
  });

  it("sets RunAtLoad and KeepAlive to true", () => {
    const plist = generatePlistContent(BUN_CMD, "/tmp/logs");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    const runAtLoadMatch = plist.match(/RunAtLoad<\/key>\s*<true\/>/);
    const keepAliveMatch = plist.match(/KeepAlive<\/key>\s*<true\/>/);
    expect(runAtLoadMatch).not.toBeNull();
    expect(keepAliveMatch).not.toBeNull();
  });

  it("sets correct log paths", () => {
    const plist = generatePlistContent(BUN_CMD, "/home/user/.3router/logs");
    expect(plist).toContain("<string>/home/user/.3router/logs/stdout.log</string>");
    expect(plist).toContain("<string>/home/user/.3router/logs/stderr.log</string>");
  });

  it("sets ThrottleInterval to 1", () => {
    const plist = generatePlistContent(BUN_CMD, "/tmp/logs");
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toMatch(/ThrottleInterval<\/key>\s*<integer>1<\/integer>/);
  });

  it("XML-escapes special characters in command", () => {
    const weirdCmd = ["/path/with & < >.sh"];
    const plist = generatePlistContent(weirdCmd, "/tmp/logs");
    expect(plist).toContain("/path/with &amp; &lt; &gt;.sh");
  });
});

describe("generateSystemdUnitContent", () => {
  it("generates valid unit file with correct Unit section", () => {
    const unit = generateSystemdUnitContent(BUN_CMD);
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("Description=3router API proxy");
  });

  it("includes ExecStart joined from argv (bun)", () => {
    const unit = generateSystemdUnitContent(BUN_CMD);
    expect(unit).toContain("ExecStart=/usr/local/bin/bun run /opt/3router/dist/cli.js serve");
  });

  it("includes ExecStart joined from argv (node)", () => {
    const unit = generateSystemdUnitContent(NODE_CMD);
    expect(unit).toContain("ExecStart=/usr/local/bin/node /opt/3router/dist/cli.js serve");
  });

  it("sets Restart=on-failure and RestartSec=3", () => {
    const unit = generateSystemdUnitContent(BUN_CMD);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=3");
  });

  it("sets Type=simple", () => {
    const unit = generateSystemdUnitContent(BUN_CMD);
    expect(unit).toContain("Type=simple");
  });

  it("sets WantedBy=default.target", () => {
    const unit = generateSystemdUnitContent(BUN_CMD);
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("quotes arguments containing spaces", () => {
    const cmdWithSpaces = ["/path/with spaces/node", "/opt/3router/cli.js", "serve"];
    const unit = generateSystemdUnitContent(cmdWithSpaces);
    expect(unit).toContain('"/path/with spaces/node"');
  });

  it("escapes % as %% to prevent systemd specifier expansion", () => {
    const unit = generateSystemdUnitContent(["/bin/50%-prog", "serve"]);
    // % triggers quoting + is always doubled to %%
    expect(unit).toContain('ExecStart="/bin/50%%-prog" serve');
  });

  it("escapes backslash and quote inside quoted arguments", () => {
    const unit = generateSystemdUnitContent(['/path/with"quote\\and%']);
    // %  → %% (always)
    // "  → \"
    // \  → \\
    // Whitespace/quote/backslash/% present → wrapped in quotes
    expect(unit).toContain('ExecStart="/path/with\\"quote\\\\and%%"');
  });

  it("wraps empty argument in quotes", () => {
    const unit = generateSystemdUnitContent([""]);
    expect(unit).toContain('ExecStart=""');
  });

  it("does not modify plain alphanumeric arguments", () => {
    const unit = generateSystemdUnitContent(["serve"]);
    expect(unit).toContain("ExecStart=serve");
  });
});

describe("isPortInUse", () => {
  it("returns true when port is occupied", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const port = (server.address() as { port: number }).port;

    const result = await isPortInUse(port);
    expect(result).toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns false when port is free", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const result = await isPortInUse(59999);
    expect(result).toBe(false);
  });
});

describe("waitForPort", () => {
  it("resolves quickly when port is already available", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const port = (server.address() as { port: number }).port;

    const start = Date.now();
    await waitForPort(port, 5000);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects when port never becomes available", async () => {
    await expect(waitForPort(59998, 1500)).rejects.toThrow("1500ms");
  });
});

describe("constants", () => {
  it("exports LAUNCH_LABEL as com.3router.daemon", () => {
    expect(LAUNCH_LABEL).toBe("com.3router.daemon");
  });

  it("exports SYSTEMD_UNIT_NAME as 3router.service", () => {
    expect(SYSTEMD_UNIT_NAME).toBe("3router.service");
  });
});
