import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createBrowserRouter, Navigate } from "react-router-dom";
import "@xyflow/react/dist/style.css";
import "./index.css";
import { Layout } from "./components/Layout";
import { WorkspacePage } from "./pages/WorkspacePage";
import { ProjectPage } from "./pages/ProjectPage";
import { WorkflowEditorPage } from "./pages/WorkflowEditorPage";
import { FleetPage } from "./pages/FleetPage";
import { ArchitecturePage } from "./pages/ArchitecturePage";

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/workspace" replace /> },
      { path: "workspace", element: <WorkspacePage /> },
      { path: "projects/:projectId", element: <ProjectPage /> },
      {
        path: "projects/:projectId/workflows/:workflowId",
        element: <WorkflowEditorPage />,
      },
      { path: "fleet", element: <FleetPage /> },
      { path: "architecture", element: <ArchitecturePage /> },
    ],
  },
], { basename: (import.meta.env.BASE_URL || "/").replace(/\/$/, "") || "/" });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
