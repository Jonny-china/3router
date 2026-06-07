import { useState, useEffect, useCallback } from "react";

import type { Upstream, Config } from "../../../src/types";
import { api } from "../api";

interface FormData {
  name: string;
  baseUrl: string;
  apiKey: string;
}

const EMPTY_FORM: FormData = { name: "", baseUrl: "", apiKey: "" };

function maskApiKey(key: string): string {
  if (key.length <= 10) return "••••••";
  return `${key.slice(0, 7)}•••${key.slice(-3)}`;
}

export default function Upstreams() {
  const [upstreams, setUpstreams] = useState<Upstream[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);

  const loadConfig = useCallback(async () => {
    try {
      const config: Config = await api.getConfig();
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

  function openAddForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  }

  function openEditForm(upstream: Upstream) {
    setEditingId(upstream.id);
    setForm({
      name: upstream.name,
      baseUrl: upstream.baseUrl,
      apiKey: upstream.apiKey,
    });
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    try {
      if (editingId) {
        await api.updateUpstream(editingId, form);
      } else {
        await api.createUpstream(form);
      }
      closeForm();
      await loadConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save upstream");
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this upstream? This action cannot be undone.")) return;
    setError(null);

    try {
      await api.deleteUpstream(id);
      await loadConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete upstream");
    }
  }

  if (loading) {
    return (
      <div className="empty-state">
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h2>Upstreams</h2>
        <button className="btn btn-primary" onClick={openAddForm}>
          + Add Upstream
        </button>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {upstreams.length === 0 ? (
        <div className="empty-state">
          <p>No upstreams configured yet.</p>
          <button className="btn btn-primary" onClick={openAddForm}>
            Add your first upstream
          </button>
        </div>
      ) : (
        upstreams.map((upstream) => (
          <div className="card" key={upstream.id}>
            <div className="card-row">
              <div>
                <div className="card-title">{upstream.name}</div>
                <div className="card-subtitle">{upstream.baseUrl}</div>
              </div>
              <div className="card-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => openEditForm(upstream)}>
                  Edit
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(upstream.id)}>
                  Delete
                </button>
              </div>
            </div>
            <div className="card-meta">
              <span>
                Key: <span className="masked-key">{maskApiKey(upstream.apiKey)}</span>
              </span>
              <span>ID: {upstream.id}</span>
            </div>
          </div>
        ))
      )}

      {showForm && (
        <div className="form-overlay" onClick={closeForm}>
          <div className="form-panel" onClick={(e) => e.stopPropagation()}>
            <h3>{editingId ? "Edit Upstream" : "Add Upstream"}</h3>
            <form onSubmit={handleSubmit}>
              <div className="form-field">
                <label htmlFor="up-name">Name</label>
                <input
                  id="up-name"
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Anthropic Official"
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="up-url">Base URL</label>
                <input
                  id="up-url"
                  type="url"
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                  placeholder="https://api.anthropic.com"
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="up-key">API Key</label>
                <input
                  id="up-key"
                  type="text"
                  className="mono"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  placeholder="sk-ant-xxx"
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
