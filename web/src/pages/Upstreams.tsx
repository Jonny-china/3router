import { useState, useEffect, useCallback } from "react";
import { Modal } from "antd";

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
  const [showKeyInput, setShowKeyInput] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const config: Config = await api.getConfig();
      setUpstreams(config.upstreams);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载配置失败");
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
    setShowKeyInput(true);
    setShowForm(true);
  }

  function openEditForm(upstream: Upstream) {
    setEditingId(upstream.id);
    setForm({
      name: upstream.name,
      baseUrl: upstream.baseUrl,
      apiKey: upstream.apiKey,
    });
    setShowKeyInput(false);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowKeyInput(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    try {
      if (editingId) {
        const updateData = showKeyInput
          ? form
          : { name: form.name, baseUrl: form.baseUrl };
        await api.updateUpstream(editingId, updateData);
      } else {
        await api.createUpstream(form);
      }
      closeForm();
      await loadConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存上游服务失败");
    }
  }

  function handleDelete(id: string) {
    Modal.confirm({
      title: "确认删除",
      content: "确定删除此上游服务？此操作不可撤销。",
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        setError(null);
        try {
          await api.deleteUpstream(id);
          await loadConfig();
        } catch (err) {
          setError(err instanceof Error ? err.message : "删除上游服务失败");
        }
      },
    });
  }

  if (loading) {
    return (
      <div className="empty-state">
        <p>加载中…</p>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h2>上游服务</h2>
        <button className="btn btn-primary" onClick={openAddForm}>
          + 添加上游服务
        </button>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {upstreams.length === 0 ? (
        <div className="empty-state">
          <p>暂无上游服务配置。</p>
          <button className="btn btn-primary" onClick={openAddForm}>
            添加第一个上游服务
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
                  编辑
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(upstream.id)}>
                  删除
                </button>
              </div>
            </div>
            <div className="card-meta">
              <span>
                密钥: <span className="masked-key">{maskApiKey(upstream.apiKey)}</span>
              </span>
              <span>ID: {upstream.id}</span>
            </div>
          </div>
        ))
      )}

      {showForm && (
        <div className="form-overlay" onClick={closeForm}>
          <div className="form-panel" onClick={(e) => e.stopPropagation()}>
            <h3>{editingId ? "编辑上游服务" : "添加上游服务"}</h3>
            <form onSubmit={handleSubmit}>
              <div className="form-field">
                <label htmlFor="up-name">名称</label>
                <input
                  id="up-name"
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="例如 Anthropic Official"
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
                {editingId && !showKeyInput ? (
                  <div>
                    <span className="masked-key">{maskApiKey(form.apiKey)}</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ marginLeft: 10 }}
                      onClick={() => {
                        setForm({ ...form, apiKey: "" });
                        setShowKeyInput(true);
                      }}
                    >
                      更换
                    </button>
                  </div>
                ) : (
                  <input
                    id="up-key"
                    type="password"
                    className="mono"
                    value={form.apiKey}
                    onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                    placeholder="sk-ant-xxx"
                    required
                    autoComplete="off"
                  />
                )}
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-ghost" onClick={closeForm}>
                  取消
                </button>
                <button type="submit" className="btn btn-primary">
                  {editingId ? "保存更改" : "创建"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
