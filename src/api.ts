import { readConfig, saveConfig } from "./config";
import type { Config, Upstream, Rule } from "./types";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Extracts :id from URL path like "/api/upstreams/some-id"
 */
function extractId(url: string, prefix: string): string | null {
  const match = new URL(url).pathname.match(
    new RegExp(`^${prefix.replace(/\//g, "\\/")}\\/([^/]+)$`),
  );
  return match?.[1] ?? null;
}

export async function handleApiRoute(req: Request): Promise<Response> {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  try {
    // GET /api/config
    if (path === "/api/config" && req.method === "GET") {
      return jsonResponse(readConfig());
    }

    // --- Upstreams ---

    // POST /api/upstreams — create
    if (path === "/api/upstreams" && req.method === "POST") {
      const body = (await req.json()) as Omit<Upstream, "id">;
      if (!body.name || !body.baseUrl || !body.apiKey) {
        return errorResponse("Missing required fields: name, baseUrl, apiKey");
      }
      const config = readConfig();
      const upstream: Upstream = { ...body, id: generateId() };
      const newConfig: Config = {
        ...config,
        upstreams: [...config.upstreams, upstream],
      };
      saveConfig(newConfig);
      return jsonResponse(upstream, 201);
    }

    // PUT /api/upstreams/:id — update
    if (path.startsWith("/api/upstreams/") && req.method === "PUT") {
      const id = extractId(req.url, "/api/upstreams");
      if (!id) return errorResponse("Missing upstream ID");
      const body = (await req.json()) as Partial<Upstream>;
      const config = readConfig();
      const index = config.upstreams.findIndex((u) => u.id === id);
      if (index === -1) return errorResponse("Upstream not found", 404);

      const updated: Upstream = { ...config.upstreams[index], ...body, id };
      const newConfig: Config = {
        ...config,
        upstreams: config.upstreams.map((u) => (u.id === id ? updated : u)),
      };
      saveConfig(newConfig);
      return jsonResponse(updated);
    }

    // DELETE /api/upstreams/:id — delete
    if (path.startsWith("/api/upstreams/") && req.method === "DELETE") {
      const id = extractId(req.url, "/api/upstreams");
      if (!id) return errorResponse("Missing upstream ID");
      const config = readConfig();
      const upstream = config.upstreams.find((u) => u.id === id);
      if (!upstream) return errorResponse("Upstream not found", 404);

      const associatedRules = config.rules.filter((r) => r.upstreamId === id);
      if (associatedRules.length > 0) {
        return errorResponse(
          `Cannot delete: ${associatedRules.length} rule(s) reference this upstream`,
        );
      }

      const newConfig: Config = {
        ...config,
        upstreams: config.upstreams.filter((u) => u.id !== id),
      };
      saveConfig(newConfig);
      return jsonResponse({ success: true });
    }

    // --- Rules ---

    // POST /api/rules — create
    if (path === "/api/rules" && req.method === "POST") {
      const body = (await req.json()) as Omit<Rule, "id">;
      if (!body.name || !body.condition || !body.upstreamId || !body.model) {
        return errorResponse("Missing required fields: name, condition, upstreamId, model");
      }
      if (body.priority === undefined || body.priority === null) {
        return errorResponse("Missing required field: priority");
      }
      const config = readConfig();
      const rule: Rule = { ...body, id: generateId() };
      const newConfig: Config = {
        ...config,
        rules: [...config.rules, rule],
      };
      saveConfig(newConfig);
      return jsonResponse(rule, 201);
    }

    // PUT /api/rules/:id — update
    if (path.startsWith("/api/rules/") && req.method === "PUT") {
      const id = extractId(req.url, "/api/rules");
      if (!id) return errorResponse("Missing rule ID");
      const body = (await req.json()) as Partial<Rule>;
      const config = readConfig();
      const index = config.rules.findIndex((r) => r.id === id);
      if (index === -1) return errorResponse("Rule not found", 404);

      const updated: Rule = { ...config.rules[index], ...body, id };
      const newConfig: Config = {
        ...config,
        rules: config.rules.map((r) => (r.id === id ? updated : r)),
      };
      saveConfig(newConfig);
      return jsonResponse(updated);
    }

    // DELETE /api/rules/:id — delete (must keep at least one default rule)
    if (path.startsWith("/api/rules/") && req.method === "DELETE") {
      const id = extractId(req.url, "/api/rules");
      if (!id) return errorResponse("Missing rule ID");
      const config = readConfig();
      const rule = config.rules.find((r) => r.id === id);
      if (!rule) return errorResponse("Rule not found", 404);

      if (rule.condition === "default") {
        const defaultCount = config.rules.filter((r) => r.condition === "default").length;
        if (defaultCount <= 1) {
          return errorResponse(
            "Cannot delete the last default rule — at least one default rule is required",
          );
        }
      }

      const newConfig: Config = {
        ...config,
        rules: config.rules.filter((r) => r.id !== id),
      };
      saveConfig(newConfig);
      return jsonResponse({ success: true });
    }

    return errorResponse("Not found", 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal API error";
    console.error(`[api error] ${message}`);
    return errorResponse(message, 500);
  }
}
