import { createServer } from "node:net";

export const LAUNCH_LABEL = "com.3router.daemon";
export const SYSTEMD_UNIT_NAME = "3router.service";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Quote a single ExecStart argument per systemd quoting rules:
 * - `%` is always doubled (systemd expands %-specifiers even inside quotes)
 * - `\` becomes `\\` and `"` becomes `\"` inside double quotes
 * - arguments containing whitespace, `"`, `\`, `%`, or empty strings get wrapped in `"..."`
 */
function escapeSystemdArg(arg: string): string {
  const needsQuote = arg === "" || /[\s"\\%]/.test(arg);
  const escaped = arg.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return needsQuote ? `"${escaped}"` : escaped;
}

/**
 * Generate launchd plist XML content.
 * command is a string array forming the full argv for the service.
 */
export function generatePlistContent(command: string[], logsDir: string): string {
  const argv = command.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>1</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(logsDir)}/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logsDir)}/stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(process.env.HOME ?? "")}</string>
  </dict>
</dict>
</plist>`;
}

/**
 * Generate systemd user unit file content.
 * command is a string array forming the full argv for ExecStart.
 */
export function generateSystemdUnitContent(command: string[]): string {
  const execStart = command.map(escapeSystemdArg).join(" ");
  return `[Unit]
Description=3router API proxy

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

/**
 * Check if a TCP port is currently in use.
 */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    // 显式 IPv4：与 Bun.serve 的 hostname "0.0.0.0" 对齐。默认 listen(port) 绑 IPv6 :: (dual-stack)，
    // 与 IPv4 监听者不冲突会误判端口空闲，导致 verifyStartup 的 waitForPort 永远等不到 true 而超时。
    server.listen(port, "0.0.0.0");
  });
}

/**
 * Poll a port every 500ms until it becomes available.
 * Rejects if the port is not available within the timeout.
 */
export function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const maxAttempts = Math.ceil(timeoutMs / 500);
  let attempts = 0;

  return new Promise((resolve, reject) => {
    function check() {
      attempts++;
      isPortInUse(port).then((inUse) => {
        if (inUse) {
          resolve();
        } else if (attempts >= maxAttempts) {
          reject(new Error(`等待 3router 启动超时（${timeoutMs}ms）`));
        } else {
          setTimeout(check, 500);
        }
      });
    }
    check();
  });
}
