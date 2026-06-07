import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDir: string;
let originalCwd: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "3router-test-"));
  originalCwd = process.cwd();
  process.chdir(testDir);
});

afterEach(() => {
  process.chdir(originalCwd);
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
  it("reads and parses a valid config.json", async () => {
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
  it("writes config to config.json", async () => {
    const { saveConfig, readConfig } = await import("./config");
    const config = { ...validConfig, port: 8080 };
    saveConfig(config);
    const loaded = readConfig();
    expect(loaded.port).toBe(8080);
    expect(loaded.upstreams).toHaveLength(1);
  });
});

describe("initConfig", () => {
  it("copies config.example.json to config.json when config.json is missing", async () => {
    // Write the example config in the test dir (simulating project root)
    writeFileSync(join(testDir, "config.example.json"), JSON.stringify(validConfig));
    const { initConfig } = await import("./config");
    const result = initConfig();
    expect(result).toBe(true);
    const { readConfig } = await import("./config");
    const config = readConfig();
    expect(config.port).toBe(9191);
  });

  it("returns false when config.json already exists", async () => {
    writeConfigFile(validConfig);
    writeFileSync(join(testDir, "config.example.json"), JSON.stringify(validConfig));
    const { initConfig } = await import("./config");
    const result = initConfig();
    expect(result).toBe(false);
  });
});
