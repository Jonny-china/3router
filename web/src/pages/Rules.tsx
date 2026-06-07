import { useState, useEffect, useCallback } from "react";
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Tag,
  App,
  Typography,
} from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";

import type { Rule, Upstream, Config, RuleCondition } from "../../../src/types";
import { api } from "../api";

const { Text } = Typography;

interface FormValues {
  name: string;
  condition: RuleCondition;
  upstreamId: string;
  model: string;
  priority: number;
}

const EMPTY_FORM: FormValues = {
  name: "",
  condition: "default",
  upstreamId: "",
  model: "",
  priority: 100,
};

function conditionTag(condition: RuleCondition) {
  switch (condition) {
    case "has_image":
      return <Tag color="orange">包含图片</Tag>;
    case "default":
      return <Tag color="green">默认</Tag>;
  }
}

export default function Rules() {
  const { message, modal } = App.useApp();
  const [rules, setRules] = useState<Rule[]>([]);
  const [upstreams, setUpstreams] = useState<Upstream[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<FormValues>();

  const loadConfig = useCallback(async () => {
    try {
      const config: Config = await api.getConfig();
      setRules(config.rules.toSorted((a, b) => a.priority - b.priority));
      setUpstreams(config.upstreams);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "加载配置失败");
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  function getUpstreamName(id: string): string {
    return upstreams.find((u) => u.id === id)?.name ?? `未知 (${id})`;
  }

  function openAddModal() {
    setEditingId(null);
    form.resetFields();
    form.setFieldsValue({
      ...EMPTY_FORM,
      upstreamId: upstreams[0]?.id ?? "",
    });
    setModalOpen(true);
  }

  function openEditModal(rule: Rule) {
    setEditingId(rule.id);
    form.setFieldsValue({
      name: rule.name,
      condition: rule.condition,
      upstreamId: rule.upstreamId,
      model: rule.model,
      priority: rule.priority,
    });
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingId(null);
    form.resetFields();
  }

  async function handleSubmit(values: FormValues) {
    setSubmitting(true);
    try {
      if (editingId) {
        await api.updateRule(editingId, values);
        message.success("路由规则已更新");
      } else {
        await api.createRule(values);
        message.success("路由规则已创建");
      }
      closeModal();
      await loadConfig();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "保存路由规则失败");
    } finally {
      setSubmitting(false);
    }
  }

  function handleDelete(id: string, name: string) {
    modal.confirm({
      title: "确认删除",
      content: `确定删除路由规则「${name}」？此操作不可撤销。`,
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await api.deleteRule(id);
          message.success("路由规则已删除");
          await loadConfig();
        } catch (err) {
          message.error(err instanceof Error ? err.message : "删除路由规则失败");
        }
      },
    });
  }

  const columns: ColumnsType<Rule> = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      render: (text: string, record: Rule) => (
        <Space direction="vertical" size={0}>
          <Text strong>{text}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            → {getUpstreamName(record.upstreamId)} / {record.model}
          </Text>
        </Space>
      ),
    },
    {
      title: "条件",
      dataIndex: "condition",
      key: "condition",
      render: (condition: RuleCondition) => conditionTag(condition),
    },
    {
      title: "优先级",
      dataIndex: "priority",
      key: "priority",
      sorter: (a, b) => a.priority - b.priority,
      defaultSortOrder: "ascend" as const,
    },
    {
      title: "操作",
      key: "actions",
      align: "right" as const,
      render: (_: unknown, record: Rule) => (
        <Space>
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={() => openEditModal(record)}
          >
            编辑
          </Button>
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDelete(record.id, record.name)}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 24,
        }}
      >
        <Typography.Title level={3} style={{ margin: 0 }}>
          路由规则
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openAddModal}>
          添加规则
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={rules}
        rowKey="id"
        loading={loading}
        pagination={false}
        locale={{ emptyText: "暂无路由规则配置" }}
      />

      <Modal
        title={editingId ? "编辑规则" : "添加规则"}
        open={modalOpen}
        onCancel={closeModal}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        destroyOnHidden
        okText={editingId ? "保存更改" : "创建"}
        cancelText="取消"
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          initialValues={EMPTY_FORM}
          style={{ marginTop: 16 }}
        >
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: "请输入名称" }]}
          >
            <Input placeholder="例如 图片消息" />
          </Form.Item>

          <Form.Item
            name="condition"
            label="条件"
            rules={[{ required: true }]}
          >
            <Select
              options={[
                { value: "default", label: "默认" },
                { value: "has_image", label: "包含图片" },
              ]}
            />
          </Form.Item>

          <Form.Item
            name="upstreamId"
            label="上游服务"
            rules={[{ required: true, message: "请选择上游服务" }]}
          >
            <Select
              options={upstreams.map((u) => ({ value: u.id, label: u.name }))}
              placeholder="选择上游服务"
            />
          </Form.Item>

          <Form.Item
            name="model"
            label="模型"
            rules={[{ required: true, message: "请输入模型名称" }]}
          >
            <Input placeholder="例如 claude-sonnet-4-6" />
          </Form.Item>

          <Form.Item
            name="priority"
            label="优先级"
            rules={[{ required: true, message: "请输入优先级" }]}
            tooltip="数字越小优先级越高"
          >
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
