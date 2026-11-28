import { QueryClient, QueryClientProvider, QueryErrorResetBoundary } from '@tanstack/react-query';
import { useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { UploadDialog } from '../entities/document/UploadDialog.js';
import { DocumentDetailPage } from '../routes/DocumentDetailPage.js';
import { DocumentsListPage } from '../routes/DocumentsListPage.js';
import { DEFAULT_POLL_MS } from '../shared/api/polling.js';
import { ErrorBoundary } from '../shared/ui/ErrorBoundary.js';
import { AppShell } from './AppShell.js';

function resolvePollMsFromSearch(search: string, fallback: number): number {
  const raw = new URLSearchParams(search).get('pollMs');
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 100 || parsed > 60_000) return fallback;
  return Math.floor(parsed);
}

export function AppRoutes({ pollMs }: { readonly pollMs?: number }) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const routeResetKey = `${location.pathname}${location.search}`;
  const effectivePollMs = pollMs ?? resolvePollMsFromSearch(location.search, DEFAULT_POLL_MS);

  return (
    <AppShell onOpenUpload={() => setUploadOpen(true)}>
      <QueryErrorResetBoundary>
        {({ reset }) => (
          <ErrorBoundary onReset={reset} resetKey={routeResetKey}>
            <Routes>
              <Route path="/" element={<Navigate to="/documents?view=needs-review" replace />} />
              <Route
                path="/documents"
                element={
                  <DocumentsListPage
                    onOpenUpload={() => setUploadOpen(true)}
                    pollMs={effectivePollMs}
                  />
                }
              />
              <Route
                path="/documents/:id"
                element={<DocumentDetailPage pollMs={effectivePollMs} />}
              />
              <Route
                path="/documents/:id/versions/:n"
                element={<DocumentDetailPage pollMs={effectivePollMs} />}
              />
              <Route path="*" element={<Navigate to="/documents?view=needs-review" replace />} />
            </Routes>
          </ErrorBoundary>
        )}
      </QueryErrorResetBoundary>

      <UploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={(documentId) => {
          setUploadOpen(false);
          void navigate(`/documents/${documentId}`);
        }}
      />
    </AppShell>
  );
}

const defaultQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={defaultQueryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
