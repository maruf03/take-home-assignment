import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../src/app/App.js';
import {
  DOC_ID_1,
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

  it('renders tabs, 99+ capped facets badge, progress bar role=img for queued docs, newerFailed chip, and switches tabs', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/documents', ({ request }) => {
        const status = new URL(request.url).searchParams.get('status');
        if (status === 'failed') {
          return HttpResponse.json({
            data: [
              makeSampleDocumentSummary({
                id: DOC_ID_2,
                title: 'Broken Scan.pdf',
                status: 'failed',
                valuesVersion: null,
                progress: {
                  versionNumber: 1,
                  pending: 0,
                  approved: 0,
                  corrected: 0,
                  carriedOver: 0,
                  total: 0,
                  gaps: 0,
                },
                needsReview: false,
              }),
            ],
            page: { limit: 20, hasMore: false, nextCursor: null },
          });
        }
        return HttpResponse.json({
          data: [
            makeSampleDocumentSummary({
              valuesVersion: 1,
              currentVersion: {
                ...makeSampleDocumentSummary().currentVersion,
                number: 2,
                status: 'failed',
                error: { code: 'PARSE_NO_TEXT', message: 'No text', retryable: false },
              },
            }),
          ],
          page: { limit: 20, hasMore: false, nextCursor: null },
        });
      }),
    );

    renderAt('/documents?view=needs-review');

    // Facets count capped at 100 renders "99+"
    const needsReviewTab = await screen.findByRole('tab', { name: /needs review/i });
    await waitFor(() => {
      expect(needsReviewTab).toHaveTextContent('99+');
    });
    expect(screen.getByRole('tab', { name: /^all$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^failed$/i })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();

    expect(await screen.findByText('Invoice — Meridian Office Supplies')).toBeInTheDocument();
    expect(screen.getByText(/3 to review/i)).toBeInTheDocument();
    expect(screen.getByText(/v2 failed/i)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /^failed$/i }));
    expect(await screen.findByText('Broken Scan.pdf')).toBeInTheDocument();
    // ProgressBar with total=0 must carry role="img" for ARIA compliance
    expect(screen.getByRole('img', { name: /no extracted fields yet/i })).toBeInTheDocument();
  });

  it('keeps focus while typing in UploadDialog, resets form on close, shows 413/415/422/429 errors, and navigates on 201', async () => {
    const user = userEvent.setup();
    renderAt('/documents?view=needs-review');

    await user.click(await screen.findByRole('button', { name: /upload pdf/i }));
    const dialog = await screen.findByRole('dialog', { name: /upload pdf/i });
    expect(dialog).toBeInTheDocument();

    // Typing into Title must keep focus on the input (no focus theft on keystroke)
    const titleInput = screen.getByLabelText(/title \(optional\)/i);
    await user.click(titleInput);
    await user.type(titleInput, 'Q4 Invoice');
    expect(titleInput).toHaveFocus();
    expect(titleInput).toHaveValue('Q4 Invoice');

    // Closing dialog resets title and file state
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /upload pdf/i }));
    expect(await screen.findByLabelText(/title \(optional\)/i)).toHaveValue('');

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

    // 429 RATE_LIMITED with Retry-After
    server.use(
      http.post('/api/documents', () =>
        HttpResponse.json(makeProblem(429, 'RATE_LIMITED', 'Rate limited'), {
          status: 429,
          headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '15' },
        }),
      ),
    );
    await user.click(screen.getByRole('button', { name: /^upload$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/wait 15s/i);

    // 201 success closes dialog and navigates to detail view
    const created = makeSampleDocumentDetail({ id: DOC_ID_1 });
    server.use(http.post('/api/documents', () => HttpResponse.json(created, { status: 201 })));
    await user.click(screen.getByRole('button', { name: /^upload$/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(await screen.findByText('Total Amount')).toBeInTheDocument();
  });

  it('bubbles ContractMismatchError on documents list to the route ErrorBoundary', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    server.use(http.get('/api/documents', () => HttpResponse.json({ bad: 'payload' })));

    renderAt('/documents?view=needs-review');

    expect(await screen.findByRole('alert')).toHaveTextContent(/unexpected response from server/i);
    consoleErr.mockRestore();
  });
});
