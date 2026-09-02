import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import { TripListPage } from "./pages/TripListPage";
import { TripPage } from "./pages/TripPage";
import { SharePage } from "./pages/SharePage";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <Routes>
        <Route path="/" element={<TripListPage />} />
        <Route path="/trip/:tripId" element={<TripPage />} />
        <Route path="/share/:token" element={<SharePage />} />
      </Routes>
    </HashRouter>
  </React.StrictMode>,
);
