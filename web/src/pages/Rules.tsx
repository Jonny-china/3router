import { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import type { Rule, Upstream, Config, RuleCondition } from "../../../src/types";

interface FormData {
  name: string;
  condition: RuleCondition;
  upstreamId: string;
  model: string;
  priority: number;
}

const EMPTY_FORM: FormData = {
  name: "",
  condition: "default",
  upstreamId: "",
  model: "",
  priority: 100,
};

function conditionLabel(condition: RuleCondition): string {
  switch (condition) {
    case "has_image":
      return "Has Image";
    case "default":
      return "Default";
  }
}

export default function Rules() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [upstreams, setUpstreams] = useState<Upstream[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);

  const loadConfig = useCallback(async () => {
    try {
      const config: Config = await api.getConfig();
      setRules([...config.rules].sort((a, b) => a.priority - b.priority));
      setUpstreams(config.upstreams);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load config");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  function getUpstreamName(id: string): string {
    return upstreams.find((u) => u.id === id)?.name ?? `Unknown (${id})`;
  }

  function openAddForm() {
    setEditingId(null);
    setForm({
      ...EMPTY_FORM,
      upstreamId: upstreams[0]?.id ?? "",
    });
    setShowForm(true);
  }

  function openEditForm(rule: Rule) {
    setEditingId(rule.id);
    setForm({
      name: rule.name,
      condition: rule.condition,
      upstreamId: rule.upstreamId,
      model: rule.model,
      priority: rule.priority,
    });
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    try {
      if (editingId) {
        await api.updateRule(editingId, form);
      } else {
        await api.createRule(form);
      }
      closeForm();
      await loadConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save rule");
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this rule? This action cannot be undone.")) return;
    setError(null);

    try {
      await api.deleteRule(id);
      await loadConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete rule");
    }
  }

  if (loading) {
    return <div className="empty-state"><p>Loading…</p></div>;
  }

  return (
    <div>
      <div className="page-header">
        <h2>Routing Rules</h2>
        <button className="btn btn-primary" onClick={openAddForm}>
          + Add Rule
        </button>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {rules.length === 0 ? (
        <div className="empty-state">
          <p>No routing rules configured.</p>
          <button className="btn btn-primary" onClick={openAddForm}>
            Add your first rule
          </button>
        </div>
      ) : (
        rules.map((rule) => (
          <div className="card" key={rule.id}>
            <div className="card-row">
              <div>
                <div className="card-title">{rule.name}</div>
                <div className="card-subtitle">
                  → {getUpstreamName(rule.upstreamId)} / {rule.model}
                </div>
              </div>
              <div className="card-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => openEditForm(rule)}
                >
                  Edit
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => handleDelete(rule.id)}
                >
                  Delete
                </button>
              </div>
            </div>
            <div className="card-meta">
              <span className={`badge ${rule.condition === "default" ? "badge-accent" : "badge-warning"}`}>
                {conditionLabel(rule.condition)}
              </span>
              <span>Priority: {rule.priority}</span>
            </div>
          </div>
        ))
      )}

      {showForm && (
        <div className="form-overlay" onClick={closeForm}>
          <div className="form-panel" onClick={(e) => e.stopPropagation()}>
            <h3>{editingId ? "Edit Rule" : "Add Rule"}</h3>
            <form onSubmit={handleSubmit}>
              <div className="form-field">
                <label htmlFor="rule-name">Name</label>
                <input
                  id="rule-name"
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Image Messages"
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="rule-condition">Condition</label>
                <select
                  id="rule-condition"
                  value={form.condition}
                  onChange={(e) =>
                    setForm({ ...form, condition: e.target.value as RuleCondition })
                  }
                >
                  <option value="default">Default</option>
                  <option value="has_image">Has Image</option>
                </select>
              </div>
              <div className="form-field">
                <label htmlFor="rule-upstream">Upstream</label>
                <select
                  id="rule-upstream"
                  value={form.upstreamId}
                  onChange={(e) =>
                    setForm({ ...form, upstreamId: e.target.value })
                  }
                >
                  {upstreams.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field">
                <label htmlFor="rule-model">Model</label>
                <input
                  id="rule-model"
                  type="text"
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                  placeholder="e.g. claude-sonnet-4-6"
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="rule-priority">Priority</label>
                <input
                  id="rule-priority"
                  type="number"
                  value={form.priority}
                  onChange={(e) =>
                    setForm({ ...form, priority: Number(e.target.value) })
                  }
                  min={0}
                  required
                />
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-ghost" onClick={closeForm}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {editingId ? "Save Changes" : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
