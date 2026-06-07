import { readConfig, updateConfig } from "./config";
import type { Upstream, Rule } from "./types";

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:9191",
];

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function jsonResponse(data: unknown, req: Request, status = 200): Response {
  return Response.json(data, { status, headers: getCorsHeaders(req) });
}

function errorResponse(message: string, req: Request, status = 400): Response {
  return jsonResponse({ error: message }, req, status);
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
    return new Response(null, { status: 204, headers: getCorsHeaders(req) });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  try {
    // GET /api/config
    if (path === "/api/config" && req.method === "GET") {
      return jsonResponse(readConfig(), req);
    }

    // --- Upstreams ---

    // POST /api/upstreams — create
    if (path === "/api/upstreams" && req.method === "POST") {
      const body = (await req.json()) as Omit<Upstream, "id">;
      if (!body.name || !body.baseUrl || !body.apiKey) {
        return errorResponse("缺少必填字段：name、baseUrl、apiKey", req);
      }
      const upstream: Upstream = { ...body, id: generateId() };
      await updateConfig((config) => ({
        ...config,
        upstreams: [...config.upstreams, upstream],
      }));
      return jsonResponse(upstream, req, 201);
    }

    // PUT /api/upstreams/:id — update
    if (path.startsWith("/api/upstreams/") && req.method === "PUT") {
      const id = extractId(req.url, "/api/upstreams");
      if (!id) return errorResponse("缺少上游服务 ID", req);
      const body = (await req.json()) as Partial<Upstream>;
      let updated: Upstream | undefined;
      try {
        await updateConfig((config) => {
          const index = config.upstreams.findIndex((u) => u.id === id);
          if (index === -1) throw new Error("NOT_FOUND");
          updated = { ...config.upstreams[index], ...body, id };
          return { ...config, upstreams: config.upstreams.map((u) => (u.id === id ? updated! : u)) };
        });
      } catch (err) {
        if (err instanceof Error && err.message === "NOT_FOUND") {
          return errorResponse("上游服务不存在", req, 404);
        }
        throw err;
      }
      return jsonResponse(updated!, req);
    }

    // DELETE /api/upstreams/:id — delete
    if (path.startsWith("/api/upstreams/") && req.method === "DELETE") {
      const id = extractId(req.url, "/api/upstreams");
      if (!id) return errorResponse("缺少上游服务 ID", req);
      try {
        await updateConfig((config) => {
          const upstream = config.upstreams.find((u) => u.id === id);
          if (!upstream) throw new Error("UPSTREAM_NOT_FOUND");
          const associatedRules = config.rules.filter((r) => r.upstreamId === id);
          if (associatedRules.length > 0) {
            throw new Error(`REFERENCED_BY_RULES:${associatedRules.length}`);
          }
          return { ...config, upstreams: config.upstreams.filter((u) => u.id !== id) };
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "UPSTREAM_NOT_FOUND") return errorResponse("上游服务不存在", req, 404);
        if (msg.startsWith("REFERENCED_BY_RULES:")) {
          const count = msg.split(":")[1];
          return errorResponse(`无法删除：${count} 条规则引用了此上游服务`, req);
        }
        throw err;
      }
      return jsonResponse({ success: true }, req);
    }

    // --- Rules ---

    // POST /api/rules — create
    if (path === "/api/rules" && req.method === "POST") {
      const body = (await req.json()) as Omit<Rule, "id">;
      if (!body.name || !body.condition || !body.upstreamId || !body.model) {
        return errorResponse("缺少必填字段：name、condition、upstreamId、model", req);
      }
      if (body.priority === undefined || body.priority === null) {
        return errorResponse("缺少必填字段：priority", req);
      }
      const rule: Rule = { ...body, id: generateId() };
      await updateConfig((config) => ({
        ...config,
        rules: [...config.rules, rule],
      }));
      return jsonResponse(rule, req, 201);
    }

    // PUT /api/rules/:id — update
    if (path.startsWith("/api/rules/") && req.method === "PUT") {
      const id = extractId(req.url, "/api/rules");
      if (!id) return errorResponse("缺少规则 ID", req);
      const body = (await req.json()) as Partial<Rule>;
      let updated: Rule | undefined;
      try {
        await updateConfig((config) => {
          const index = config.rules.findIndex((r) => r.id === id);
          if (index === -1) throw new Error("NOT_FOUND");
          updated = { ...config.rules[index], ...body, id };
          return { ...config, rules: config.rules.map((r) => (r.id === id ? updated! : r)) };
        });
      } catch (err) {
        if (err instanceof Error && err.message === "NOT_FOUND") {
          return errorResponse("规则不存在", req, 404);
        }
        throw err;
      }
      return jsonResponse(updated!, req);
    }

    // DELETE /api/rules/:id — delete (must keep at least one default rule)
    if (path.startsWith("/api/rules/") && req.method === "DELETE") {
      const id = extractId(req.url, "/api/rules");
      if (!id) return errorResponse("缺少规则 ID", req);
      try {
        await updateConfig((config) => {
          const rule = config.rules.find((r) => r.id === id);
          if (!rule) throw new Error("RULE_NOT_FOUND");
          if (rule.condition === "default") {
            const defaultCount = config.rules.filter((r) => r.condition === "default").length;
            if (defaultCount <= 1) {
              throw new Error("LAST_DEFAULT_RULE");
            }
          }
          return { ...config, rules: config.rules.filter((r) => r.id !== id) };
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "RULE_NOT_FOUND") return errorResponse("规则不存在", req, 404);
        if (msg === "LAST_DEFAULT_RULE") {
          return errorResponse(
            "无法删除最后一条默认规则，至少需要保留一条默认规则",
            req,
          );
        }
        throw err;
      }
      return jsonResponse({ success: true }, req);
    }

    return errorResponse("接口不存在", req, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : "内部服务错误";
    console.error(`[接口错误] ${message}`);
    return errorResponse(message, req, 500);
  }
}
