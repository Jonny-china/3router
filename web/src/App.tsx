import { useState } from "react";
import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Layout, Menu, Button, theme } from "antd";
import {
  CloudUploadOutlined,
  BranchesOutlined,
  SunOutlined,
  MoonOutlined,
} from "@ant-design/icons";

import { useTheme } from "./theme";
import Rules from "./pages/Rules";
import Upstreams from "./pages/Upstreams";

import "./App.css";

const { Sider, Content } = Layout;

const MENU_ITEMS = [
  { key: "/upstreams", icon: <CloudUploadOutlined />, label: "上游服务" },
  { key: "/rules", icon: <BranchesOutlined />, label: "路由规则" },
];

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const { isDark, toggle } = useTheme();
  const { token } = theme.useToken();

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme={isDark ? "dark" : "light"}
        style={{ borderRight: `1px solid ${token.colorBorderSecondary}` }}
      >
        <div
          style={{
            padding: collapsed ? "16px 8px" : "20px 20px 16px",
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            textAlign: collapsed ? "center" : "left",
          }}
        >
          <h1
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: token.colorText,
              margin: 0,
              whiteSpace: "nowrap",
            }}
          >
            {collapsed ? "3R" : "3router"}
          </h1>
          {!collapsed && (
            <span
              style={{
                fontSize: 11,
                color: token.colorTextQuaternary,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              API 代理
            </span>
          )}
        </div>

        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={MENU_ITEMS}
          onClick={({ key }) => navigate(key)}
          theme={isDark ? "dark" : "light"}
          style={{ border: "none", marginTop: 8 }}
        />

        <div
          style={{
            position: "absolute",
            bottom: 48,
            width: "100%",
            padding: "0 16px",
          }}
        >
          <Button
            type="text"
            icon={isDark ? <SunOutlined /> : <MoonOutlined />}
            onClick={toggle}
            block
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: collapsed ? "center" : "flex-start",
              gap: 8,
              color: token.colorTextSecondary,
            }}
          >
            {!collapsed && (isDark ? "浅色模式" : "深色模式")}
          </Button>
        </div>
      </Sider>

      <Layout>
        <Content
          style={{
            padding: "32px 40px",
            maxWidth: 1000,
            width: "100%",
            background: token.colorBgLayout,
          }}
        >
          <Routes>
            <Route path="/upstreams" element={<Upstreams />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="*" element={<Navigate to="/upstreams" replace />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}
