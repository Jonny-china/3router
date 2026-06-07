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
}

export interface Config {
  port: number;
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

export interface ProxyRequest {
  method: string;
  url: string;
  headers: Headers;
  body: {
    model?: string;
    messages?: Message[];
    [key: string]: unknown;
  };
}

export interface RouteMatch {
  upstream: Upstream;
  model: string;
}
