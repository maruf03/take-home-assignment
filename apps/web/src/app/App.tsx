import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { UploadDialog } from '../entities/document/UploadDialog.js';
import { DocumentDetailPage } from '../routes/DocumentDetailPage.js';
import { DocumentsListPage } from '../routes/DocumentsListPage.js';
import { DEFAULT_POLL_MS } from '../shared/api/polling.js';
import { ErrorBoundary } from '../shared/ui/ErrorBoundary.js';
import { AppShell } from './AppShell.js';

export function AppRoutes({ pollMs = DEFAULT_POLL_MS }: { readonly pollMs?: number }) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <AppShell onOpenUpload={() => setUploadOpen(true)}>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Navigate to="/documents?view=needs-review" replace />} />
          <Route
            path="/documents"
            element={<DocumentsListPage onOpenUpload={() => setUploadOpen(true)} pollMs={pollMs} />}
          />
          <Route path="/documents/:id" element={<DocumentDetailPage pollMs={pollMs} />} />
          <Route
            path="/documents/:id/versions/:n"
            element={<DocumentDetailPage pollMs={pollMs} />}
          />
          <Route path="*" element={<Navigate to="/documents?view=needs-review" replace />} />
        </Routes>
      </ErrorBoundary>

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
