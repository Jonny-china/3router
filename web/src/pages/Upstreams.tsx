import { useState, useEffect, useCallback } from "react";
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Space,
  Tag,
  App,
  Typography,
} from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  EyeInvisibleOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";

import type { Upstream, Config } from "../../../src/types";
import { api } from "../api";

const { Text } = Typography;

interface FormValues {
  name: string;
  baseUrl: string;
  apiKey: string;
}

function maskApiKey(key: string): string {
  if (key.length <= 10) return "••••••";
  return `${key.slice(0, 7)}•••${key.slice(-3)}`;
}

export default function Upstreams() {
  const { message, modal } = App.useApp();
  const [upstreams, setUpstreams] = useState<Upstream[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<FormValues>();

  const loadConfig = useCallback(async () => {
    try {
      const config: Config = await api.getConfig();
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

  function openAddModal() {
    setEditingId(null);
    setShowKeyInput(true);
    form.resetFields();
    setModalOpen(true);
  }

  function openEditModal(upstream: Upstream) {
    setEditingId(upstream.id);
    setShowKeyInput(false);
    form.setFieldsValue({
      name: upstream.name,
      baseUrl: upstream.baseUrl,
      apiKey: upstream.apiKey,
    });
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingId(null);
    setShowKeyInput(false);
    form.resetFields();
  }

  async function handleSubmit(values: FormValues) {
    setSubmitting(true);
    try {
      if (editingId) {
        const updateData = showKeyInput
          ? values
          : { name: values.name, baseUrl: values.baseUrl };
        await api.updateUpstream(editingId, updateData);
        message.success("上游服务已更新");
      } else {
        await api.createUpstream(values);
        message.success("上游服务已创建");
      }
      closeModal();
      await loadConfig();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "保存上游服务失败");
    } finally {
      setSubmitting(false);
    }
  }

  function handleDelete(id: string, name: string) {
    modal.confirm({
      title: "确认删除",
      content: `确定删除上游服务「${name}」？此操作不可撤销。`,
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await api.deleteUpstream(id);
          message.success("上游服务已删除");
          await loadConfig();
        } catch (err) {
          message.error(err instanceof Error ? err.message : "删除上游服务失败");
        }
      },
    });
  }

  const columns: ColumnsType<Upstream> = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      render: (text: string, record: Upstream) => (
        <Space direction="vertical" size={0}>
          <Text strong>{text}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {record.baseUrl}
          </Text>
        </Space>
      ),
    },
    {
      title: "密钥",
      key: "apiKey",
      render: (_: unknown, record: Upstream) => (
        <Text code className="font-mono">
          {maskApiKey(record.apiKey)}
        </Text>
      ),
    },
    {
      title: "认证",
      key: "authScheme",
      render: (_: unknown, record: Upstream) => (
        <Tag color={record.authScheme === "x-api-key" ? "orange" : "blue"}>
          {record.authScheme === "x-api-key" ? "X-API-Key" : "Bearer"}
        </Tag>
      ),
    },
    {
      title: "ID",
      dataIndex: "id",
      key: "id",
      render: (id: string) => (
        <Text type="secondary" className="font-mono" style={{ fontSize: 12 }}>
          {id}
        </Text>
      ),
    },
    {
      title: "操作",
      key: "actions",
      align: "right" as const,
      render: (_: unknown, record: Upstream) => (
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
          上游服务
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openAddModal}>
          添加上游服务
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={upstreams}
        rowKey="id"
        loading={loading}
        pagination={false}
        locale={{ emptyText: "暂无上游服务配置" }}
      />

      <Modal
        title={editingId ? "编辑上游服务" : "添加上游服务"}
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
          style={{ marginTop: 16 }}
        >
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: "请输入名称" }]}
          >
            <Input placeholder="例如 Anthropic Official" />
          </Form.Item>

          <Form.Item
            name="baseUrl"
            label="Base URL"
            rules={[
              { required: true, message: "请输入 Base URL" },
              { type: "url", message: "请输入有效的 URL" },
            ]}
          >
            <Input placeholder="https://api.anthropic.com" />
          </Form.Item>

          <Form.Item label="API Key">
            {editingId && !showKeyInput ? (
              <Space>
                <Text code className="font-mono">
                  {maskApiKey(form.getFieldValue("apiKey"))}
                </Text>
                <Button
                  type="link"
                  size="small"
                  icon={<EyeInvisibleOutlined />}
                  onClick={() => {
                    form.setFieldValue("apiKey", "");
                    setShowKeyInput(true);
                  }}
                >
                  更换密钥
                </Button>
              </Space>
            ) : (
              <Form.Item
                name="apiKey"
                noStyle
                rules={[{ required: !editingId, message: "请输入 API Key" }]}
              >
                <Input.Password
                  placeholder="sk-ant-xxx"
                  autoComplete="off"
                  className="font-mono"
                />
              </Form.Item>
            )}
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
