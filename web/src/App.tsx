import { useState } from "react";

import Rules from "./pages/Rules";
import Upstreams from "./pages/Upstreams";

import "./App.css";

type Page = "upstreams" | "rules";

export default function App() {
  const [page, setPage] = useState<Page>("upstreams");

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <h1>3router</h1>
          <span>API 代理</span>
        </div>
        <nav className="sidebar-nav">
          <button
            className={`nav-item ${page === "upstreams" ? "active" : ""}`}
            onClick={() => setPage("upstreams")}
          >
            <span className="nav-icon">⬆</span>
            上游服务
          </button>
          <button
            className={`nav-item ${page === "rules" ? "active" : ""}`}
            onClick={() => setPage("rules")}
          >
            <span className="nav-icon">⟐</span>
            路由规则
          </button>
        </nav>
      </aside>
      <main className="main-content">
        {page === "upstreams" && <Upstreams />}
        {page === "rules" && <Rules />}
      </main>
    </div>
  );
}
