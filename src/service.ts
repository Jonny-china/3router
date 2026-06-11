import { createServer } from "node:net";

export const LAUNCH_LABEL = "com.3router.daemon";
export const SYSTEMD_UNIT_NAME = "3router.service";

/**
 * Generate launchd plist XML content.
 */
export function generatePlistContent(
  bunPath: string,
  serverPath: string,
  logsDir: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>${serverPath}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>1</integer>
  <key>StandardOutPath</key>
  <string>${logsDir}/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${logsDir}/stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${process.env.HOME}</string>
  </dict>
</dict>
</plist>`;
}

/**
 * Generate systemd user unit file content.
 */
export function generateSystemdUnitContent(
  bunPath: string,
  serverPath: string,
): string {
  return `[Unit]
Description=3router API proxy

[Service]
Type=simple
ExecStart=${bunPath} run ${serverPath} serve
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
    server.listen(port);
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
