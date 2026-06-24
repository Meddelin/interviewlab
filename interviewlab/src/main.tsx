import React from "react";
import ReactDOM from "react-dom/client";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";
import App from "./App";
import { CyclesPage } from "./pages/cycles";
import { CycleDetailPage } from "./pages/cycle-detail";
import { TranscriptEditorPage } from "./pages/transcript-editor";
import { GuidesPage } from "./pages/guides";
import { ProductsPage } from "./pages/products";
import { SettingsPage } from "./pages/settings";
import { Providers } from "./providers";
import "./index.css";

// React Router (M2): App is the shell layout; nested routes render in its <Outlet />.
// list → detail is the cleanest fit for cycles, and Cycle→Interview nesting comes next.
const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Navigate to="/cycles" replace /> },
      { path: "cycles", element: <CyclesPage /> },
      { path: "cycles/:id", element: <CycleDetailPage /> },
      // The transcript editor now lives INSIDE the shell so the global header +
      // the cycle-aware Ask AI chat persist on the editor too (it's still a cycle
      // screen). It renders its own contextual sub-toolbar under the global header
      // rather than replacing the shell. Opened from an interview row.
      {
        path: "cycles/:cycleId/interviews/:interviewId",
        element: <TranscriptEditorPage />,
      },
      { path: "guides", element: <GuidesPage /> },
      { path: "products", element: <ProductsPage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </React.StrictMode>,
);
