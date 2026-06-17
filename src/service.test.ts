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

describe("generatePlistContent", () => {
  it("generates valid XML with correct label", () => {
    const plist = generatePlistContent("/usr/local/bin/bun", "/path/to/server.ts", "/tmp/logs");
    expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(plist).toContain(`<key>Label</key>`);
    expect(plist).toContain(`<string>${LAUNCH_LABEL}</string>`);
  });

  it("includes ProgramArguments with bun run and serve", () => {
    const plist = generatePlistContent(
      "/usr/local/bin/bun",
      "/opt/3router/src/server.ts",
      "/home/user/.3router/logs",
    );
    expect(plist).toContain("<string>/usr/local/bin/bun</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<string>/opt/3router/src/server.ts</string>");
    expect(plist).toContain("<string>serve</string>");
  });

  it("sets RunAtLoad and KeepAlive to true", () => {
    const plist = generatePlistContent("/usr/local/bin/bun", "/path/to/server.ts", "/tmp/logs");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    const runAtLoadMatch = plist.match(/RunAtLoad<\/key>\s*<true\/>/);
    const keepAliveMatch = plist.match(/KeepAlive<\/key>\s*<true\/>/);
    expect(runAtLoadMatch).not.toBeNull();
    expect(keepAliveMatch).not.toBeNull();
  });

  it("sets correct log paths", () => {
    const plist = generatePlistContent(
      "/usr/local/bin/bun",
      "/path/to/server.ts",
      "/home/user/.3router/logs",
    );
    expect(plist).toContain("<string>/home/user/.3router/logs/stdout.log</string>");
    expect(plist).toContain("<string>/home/user/.3router/logs/stderr.log</string>");
  });

  it("sets ThrottleInterval to 1", () => {
    const plist = generatePlistContent("/usr/local/bin/bun", "/path/to/server.ts", "/tmp/logs");
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toMatch(/ThrottleInterval<\/key>\s*<integer>1<\/integer>/);
  });
});

describe("generateSystemdUnitContent", () => {
  it("generates valid unit file with correct Unit section", () => {
    const unit = generateSystemdUnitContent("/usr/bin/bun", "/opt/3router/src/server.ts");
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("Description=3router API proxy");
  });

  it("includes ExecStart with bun run and serve", () => {
    const unit = generateSystemdUnitContent("/usr/bin/bun", "/opt/3router/src/server.ts");
    expect(unit).toContain("ExecStart=/usr/bin/bun run /opt/3router/src/server.ts serve");
  });

  it("sets Restart=on-failure and RestartSec=3", () => {
    const unit = generateSystemdUnitContent("/usr/bin/bun", "/path/to/server.ts");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=3");
  });

  it("sets Type=simple", () => {
    const unit = generateSystemdUnitContent("/usr/bin/bun", "/path/to/server.ts");
    expect(unit).toContain("Type=simple");
  });

  it("sets WantedBy=default.target", () => {
    const unit = generateSystemdUnitContent("/usr/bin/bun", "/path/to/server.ts");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=default.target");
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
