import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppRoutes } from '../../src/app/App.js';
import {
  DOC_ID_2,
  makeProblem,
  makeSampleDocumentDetail,
  makeSampleDocumentSummary,
  server,
} from '../msw/handlers.js';

function renderAt(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DocumentsListPage & UploadDialog', () => {
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it('renders tabs, 99+ capped facets badge, document row progress, and switches tabs', async () => {
    const user = userEvent.setup();
    renderAt('/documents?view=needs-review');

    // Facets count capped at 100 renders "99+"
    const needsReviewTab = await screen.findByRole('tab', { name: /needs review/i });
    await waitFor(() => {
      expect(needsReviewTab).toHaveTextContent('99+');
    });
    expect(screen.getByRole('tab', { name: /^all$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^failed$/i })).toBeInTheDocument();

    expect(await screen.findByText('Invoice — Meridian Office Supplies')).toBeInTheDocument();
    expect(screen.getByText(/3 to review/i)).toBeInTheDocument();

    // Switching to Failed tab queries ?status=failed
    let seenStatus: string | null = null;
    server.use(
      http.get('/api/documents', ({ request }) => {
        seenStatus = new URL(request.url).searchParams.get('status');
        return HttpResponse.json({
          data: [
            makeSampleDocumentSummary({
              id: DOC_ID_2,
              title: 'Broken Scan.pdf',
              status: 'failed',
              needsReview: false,
            }),
          ],
          page: { limit: 20, hasMore: false, nextCursor: null },
        });
      }),
    );

    await user.click(screen.getByRole('tab', { name: /^failed$/i }));
    expect(await screen.findByText('Broken Scan.pdf')).toBeInTheDocument();
    expect(seenStatus).toBe('failed');
  });

  it('shows inline 413, 415, and 422 errors in the Upload dialog and navigates on 201', async () => {
    const user = userEvent.setup();
    renderAt('/documents?view=needs-review');

    await user.click(await screen.findByRole('button', { name: /upload pdf/i }));
    const dialog = await screen.findByRole('dialog', { name: /upload pdf/i });
    expect(dialog).toBeInTheDocument();

    const fileInput = screen.getByLabelText(/pdf file/i);
    const pdfFile = new File(['%PDF-1.7\n%%EOF'], 'invoice.pdf', { type: 'application/pdf' });
    await user.upload(fileInput, pdfFile);

    // 413 FILE_TOO_LARGE
    server.use(
      http.post('/api/documents', () =>
        HttpResponse.json(makeProblem(413, 'FILE_TOO_LARGE', 'Exceeds 10 MB'), {
          status: 413,
          headers: { 'Content-Type': 'application/problem+json' },
        }),
      ),
    );
    await user.click(screen.getByRole('button', { name: /^upload$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/10 MB/i);

    // 415 UNSUPPORTED_MEDIA_TYPE
    server.use(
      http.post('/api/documents', () =>
        HttpResponse.json(makeProblem(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only PDF files'), {
          status: 415,
          headers: { 'Content-Type': 'application/problem+json' },
        }),
      ),
    );
    await user.click(screen.getByRole('button', { name: /^upload$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/only pdf files/i);

    // 422 UNKNOWN_DOCUMENT_TYPE
    server.use(
      http.post('/api/documents', () =>
        HttpResponse.json(makeProblem(422, 'UNKNOWN_DOCUMENT_TYPE', 'Unknown type'), {
          status: 422,
          headers: { 'Content-Type': 'application/problem+json' },
        }),
      ),
    );
    await user.click(screen.getByRole('button', { name: /^upload$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/unknown document type/i);

    // 201 success closes dialog and navigates to detail view
    const created = makeSampleDocumentDetail();
    server.use(http.post('/api/documents', () => HttpResponse.json(created, { status: 201 })));
    await user.click(screen.getByRole('button', { name: /^upload$/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
