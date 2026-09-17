import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { Toaster } from "sonner";
import { installExternalLinkHandler } from "./lib/externalLinks";
import { TripListPage } from "./pages/TripListPage";
import { TripPage } from "./pages/TripPage";
import { SharePage } from "./pages/SharePage";
import { JoinPage } from "./pages/JoinPage";

// 壳内外链统一出口（issue #15）：Tauri 环境下 target=_blank 死点击、无 target 链接会把
// 整个 WebView 导航走——document 捕获层统一转交系统浏览器；浏览器环境为 no-op
installExternalLinkHandler();

/** react-query 客户端（M102 启用）：天气等动态接口数据的缓存/刷新；bundle 仍走 zustand + SSE */
const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<TripListPage />} />
          <Route path="/trip/:tripId" element={<TripPage />} />
          <Route path="/share/:token" element={<SharePage />} />
          {/* 同伴入口（issue #18）：链接即身份，填昵称后按角色进入行程/只读页 */}
          <Route path="/join/:token" element={<JoinPage />} />
        </Routes>
        <Toaster position="top-center" richColors />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
