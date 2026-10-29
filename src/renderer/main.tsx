import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./app/globals.css";
import { Toaster } from "./components/ui/sonner";

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <HashRouter>
      <App />
      <Toaster />
    </HashRouter>
  </React.StrictMode>
);
