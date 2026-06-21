export interface Upstream {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  authScheme?: "bearer" | "x-api-key";
}

export type RuleCondition = "has_image" | "default";

export interface Rule {
  id: string;
  name: string;
  condition: RuleCondition;
  upstreamId: string;
  model: string;
  priority: number; // Lower number = higher priority
  supportsImages?: boolean;
}

export interface Config {
  port: number;
  /** 监听地址，默认 127.0.0.1（仅本机）。填 0.0.0.0 暴露到所有网卡——远程访问需自行确保网络安全。 */
  host?: string;
  upstreams: Upstream[];
  rules: Rule[];
}

// Anthropic Messages API types (subset needed for routing)
export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface RouteMatch {
  upstream: Upstream;
  model: string;
  supportsImages: boolean;
}
