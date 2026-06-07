import type { Config, Upstream, Rule } from "../../src/types";

const BASE = "/api";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

export const api = {
  getConfig: () => request<Config>("/config"),

  createUpstream: (data: Omit<Upstream, "id">) =>
    request<Upstream>("/upstreams", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateUpstream: (id: string, data: Partial<Upstream>) =>
    request<Upstream>(`/upstreams/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  deleteUpstream: (id: string) =>
    request<{ success: boolean }>(`/upstreams/${id}`, { method: "DELETE" }),

  createRule: (data: Omit<Rule, "id">) =>
    request<Rule>("/rules", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateRule: (id: string, data: Partial<Rule>) =>
    request<Rule>(`/rules/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  deleteRule: (id: string) =>
    request<{ success: boolean }>(`/rules/${id}`, { method: "DELETE" }),
};
