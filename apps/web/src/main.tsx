import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import { Toaster } from "sonner";
import { TripListPage } from "./pages/TripListPage";
import { TripPage } from "./pages/TripPage";
import { SharePage } from "./pages/SharePage";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<TripListPage />} />
        <Route path="/trip/:tripId" element={<TripPage />} />
        <Route path="/share/:token" element={<SharePage />} />
      </Routes>
      <Toaster position="top-center" richColors />
    </BrowserRouter>
  </React.StrictMode>,
);
