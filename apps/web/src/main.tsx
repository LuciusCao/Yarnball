import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { Toaster } from "sonner";
import { TripListPage } from "./pages/TripListPage";
import { TripPage } from "./pages/TripPage";
import { SharePage } from "./pages/SharePage";

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
        </Routes>
        <Toaster position="top-center" richColors />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
