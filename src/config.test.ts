import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "3router-test-"));
  process.env.THREEROUTER_HOME = testDir;
});

afterEach(() => {
  delete process.env.THREEROUTER_HOME;
  rmSync(testDir, { recursive: true, force: true });
});

function writeConfigFile(data: unknown, filename = "config.json") {
  writeFileSync(join(testDir, filename), JSON.stringify(data));
}

const validConfig = {
  port: 9191,
  upstreams: [{ id: "up-1", name: "Test", baseUrl: "https://api.test.com", apiKey: "key-1" }],
  rules: [
    {
      id: "rule-1",
      name: "Default",
      condition: "default" as const,
      upstreamId: "up-1",
      model: "claude-sonnet-4-6",
      priority: 999,
    },
  ],
};

describe("readConfig", () => {
  it("reads and parses a valid config.json from THREEROUTER_HOME", async () => {
    writeConfigFile(validConfig);
    const { readConfig } = await import("./config");
    const config = readConfig();
    expect(config.port).toBe(9191);
    expect(config.upstreams).toHaveLength(1);
    expect(config.upstreams[0].id).toBe("up-1");
    expect(config.rules).toHaveLength(1);
  });

  it("throws when config.json is missing", async () => {
    const { readConfig } = await import("./config");
    expect(() => readConfig()).toThrow();
  });

  it("throws when config.json contains invalid JSON", async () => {
    writeFileSync(join(testDir, "config.json"), "{ broken json");
    const { readConfig } = await import("./config");
    expect(() => readConfig()).toThrow();
  });
});

describe("validateConfig", () => {
  it("accepts a valid config", async () => {
    const { validateConfig } = await import("./config");
    expect(() => validateConfig(validConfig)).not.toThrow();
  });

  it("rejects when rules reference nonexistent upstream", async () => {
    const { validateConfig } = await import("./config");
    const badConfig = {
      ...validConfig,
      rules: [
        {
          id: "rule-1",
          name: "Bad",
          condition: "default" as const,
          upstreamId: "nonexistent",
          model: "claude-sonnet-4-6",
          priority: 999,
        },
      ],
    };
    expect(() => validateConfig(badConfig)).toThrow("nonexistent");
  });

  it("rejects when no default rule exists", async () => {
    const { validateConfig } = await import("./config");
    const badConfig = {
      ...validConfig,
      rules: [
        {
          id: "rule-1",
          name: "Image",
          condition: "has_image" as const,
          upstreamId: "up-1",
          model: "claude-opus-4-6",
          priority: 1,
        },
      ],
    };
    expect(() => validateConfig(badConfig)).toThrow("default");
  });

  it("rejects when upstreams array is empty", async () => {
    const { validateConfig } = await import("./config");
    const badConfig = { ...validConfig, upstreams: [] };
    expect(() => validateConfig(badConfig)).toThrow();
  });
});

describe("saveConfig", () => {
  it("writes config to config.json in THREEROUTER_HOME", async () => {
    writeConfigFile(validConfig);
    const { saveConfig, readConfig } = await import("./config");
    const config = { ...validConfig, port: 8080 };
    await saveConfig(config);
    const loaded = readConfig();
    expect(loaded.port).toBe(8080);
    expect(loaded.upstreams).toHaveLength(1);
  });
});

describe("initConfig", () => {
  it("copies config.example.json to config.json when config.json is missing", async () => {
    // The example config is resolved via import.meta.dir in config.ts,
    // so it reads from the package root, not THREEROUTER_HOME.
    // This test verifies that initConfig creates the config in THREEROUTER_HOME.
    const { initConfig, readConfig } = await import("./config");
    const result = initConfig();
    expect(result).toBe(true);
    const config = readConfig();
    expect(config.port).toBe(9191);
  });

  it("returns false when config.json already exists", async () => {
    writeConfigFile(validConfig);
    const { initConfig } = await import("./config");
    const result = initConfig();
    expect(result).toBe(false);
  });

  it("creates THREEROUTER_HOME directory if it does not exist", async () => {
    const nestedDir = join(testDir, "nested", ".3router");
    process.env.THREEROUTER_HOME = nestedDir;
    const { initConfig } = await import("./config");
    const result = initConfig();
    expect(result).toBe(true);
  });
});

describe("getBasePath", () => {
  it("returns THREEROUTER_HOME when set", async () => {
    const { getBasePath } = await import("./paths");
    expect(getBasePath()).toBe(testDir);
  });

  it("returns ~/.3router when THREEROUTER_HOME is not set", async () => {
    delete process.env.THREEROUTER_HOME;
    const { getBasePath } = await import("./paths");
    expect(getBasePath()).toBe(join(homedir(), ".3router"));
  });
});

describe("config file permissions", () => {
  it("initConfig writes config.json with mode 0o600", async () => {
    const { initConfig } = await import("./config");
    initConfig();
    const mode = statSync(join(testDir, "config.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("initConfig creates base directory with mode 0o700", async () => {
    const nested = join(testDir, "nested", ".3router");
    process.env.THREEROUTER_HOME = nested;
    const { initConfig } = await import("./config");
    initConfig();
    const mode = statSync(nested).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("updateConfig writes config.json with mode 0o600", async () => {
    writeConfigFile(validConfig);
    const { updateConfig } = await import("./config");
    await updateConfig(() => ({ ...validConfig, port: 9090 }));
    const mode = statSync(join(testDir, "config.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
