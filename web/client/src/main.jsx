import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider, Navigate } from "react-router";
import Home from "./Home";
import Chat from "./Chat";
import "./styles.css";

// React Router v7 (library mode). SPA con dos rutas:
//   /       → Home (crea conversación)
//   /c/:id  → Chat (la conversación, stream por SSE)
const router = createBrowserRouter([
  { path: "/", element: <Home /> },
  { path: "/c/:id", element: <Chat /> },
  { path: "*", element: <Navigate to="/" replace /> },
]);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
