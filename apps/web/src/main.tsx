import React from "react";
import ReactDOM from "react-dom/client";
import StudioV2App from "./StudioV2App";
import "./styles.css";
import "./advanced.css";
import "./v1.css";
import "./v2.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StudioV2App />
  </React.StrictMode>
);
