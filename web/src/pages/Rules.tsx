import { useState, useEffect, useCallback } from "react";
import { Modal } from "antd";

import type { Rule, Upstream, Config, RuleCondition } from "../../../src/types";
import { api } from "../api";

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
      return "包含图片";
    case "default":
      return "默认";
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
      setRules(config.rules.toSorted((a, b) => a.priority - b.priority));
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

  function getUpstreamName(id: string): string {
    return upstreams.find((u) => u.id === id)?.name ?? `未知 (${id})`;
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
      setError(err instanceof Error ? err.message : "保存路由规则失败");
    }
  }

  function handleDelete(id: string) {
    Modal.confirm({
      title: "确认删除",
      content: "确定删除此路由规则？此操作不可撤销。",
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        setError(null);
        try {
          await api.deleteRule(id);
          await loadConfig();
        } catch (err) {
          setError(err instanceof Error ? err.message : "删除路由规则失败");
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
        <h2>路由规则</h2>
        <button className="btn btn-primary" onClick={openAddForm}>
          + 添加规则
        </button>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {rules.length === 0 ? (
        <div className="empty-state">
          <p>暂无路由规则配置。</p>
          <button className="btn btn-primary" onClick={openAddForm}>
            添加第一条规则
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
                <button className="btn btn-ghost btn-sm" onClick={() => openEditForm(rule)}>
                  编辑
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(rule.id)}>
                  删除
                </button>
              </div>
            </div>
            <div className="card-meta">
              <span
                className={`badge ${rule.condition === "default" ? "badge-accent" : "badge-warning"}`}
              >
                {conditionLabel(rule.condition)}
              </span>
              <span>优先级: {rule.priority}</span>
            </div>
          </div>
        ))
      )}

      {showForm && (
        <div className="form-overlay" onClick={closeForm}>
          <div className="form-panel" onClick={(e) => e.stopPropagation()}>
            <h3>{editingId ? "编辑规则" : "添加规则"}</h3>
            <form onSubmit={handleSubmit}>
              <div className="form-field">
                <label htmlFor="rule-name">名称</label>
                <input
                  id="rule-name"
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="例如 图片消息"
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="rule-condition">条件</label>
                <select
                  id="rule-condition"
                  value={form.condition}
                  onChange={(e) => setForm({ ...form, condition: e.target.value as RuleCondition })}
                >
                  <option value="default">默认</option>
                  <option value="has_image">包含图片</option>
                </select>
              </div>
              <div className="form-field">
                <label htmlFor="rule-upstream">上游服务</label>
                <select
                  id="rule-upstream"
                  value={form.upstreamId}
                  onChange={(e) => setForm({ ...form, upstreamId: e.target.value })}
                >
                  {upstreams.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field">
                <label htmlFor="rule-model">模型</label>
                <input
                  id="rule-model"
                  type="text"
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                  placeholder="例如 claude-sonnet-4-6"
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="rule-priority">优先级</label>
                <input
                  id="rule-priority"
                  type="number"
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
                  min={0}
                  required
                />
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
