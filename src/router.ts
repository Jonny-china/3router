import type { Message, Rule, Upstream, RouteMatch } from "./types";

export function matchRule(
  messages: Message[],
  rules: Rule[],
  upstreams: Upstream[],
): RouteMatch | undefined {
  const sorted = rules.toSorted((a, b) => a.priority - b.priority);
  const lastMessage = messages[messages.length - 1];

  let hasImage = false;

  if (lastMessage?.role === "user" && Array.isArray(lastMessage.content)) {
    hasImage = lastMessage.content.some((block) => block.type === "image");
  }

  const targetCondition = hasImage ? "has_image" : "default";
  const matchedRule = sorted.find((r) => r.condition === targetCondition);

  if (!matchedRule) return undefined;

  const upstream = upstreams.find((u) => u.id === matchedRule.upstreamId);
  if (!upstream) return undefined;

  return { upstream, model: matchedRule.model };
}
