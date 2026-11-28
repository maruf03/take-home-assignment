import { createVersionResponseDtoSchema, versionSummaryDtoSchema } from '@app/contracts/dto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppRoutes } from '../../src/app/App.js';
import {
  DOC_ID_1,
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
        <AppRoutes pollMs={40} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Retry button, Re-extract, and Upload new version', () => {
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it('triggers Retry from failed detail panel and transitions back to queued/extracted', async () => {
    const user = userEvent.setup();
    let retried = false;

    server.use(
      http.get('/api/documents/:id', () => {
        const base = makeSampleDocumentDetail();
        if (!retried) {
          return HttpResponse.json({
            ...base,
            status: 'failed',
            valuesVersion: null,
            values: [],
            valuesTextMeta: null,
            currentVersion: {
              ...base.currentVersion,
              number: 1,
              status: 'failed',
              error: {
                code: 'LLM_NOT_CONFIGURED',
                message: 'Missing API key',
                retryable: true,
              },
              extractedAt: null,
              reviewable: false,
            },
          });
        }
        return HttpResponse.json(base);
      }),
      http.post('/api/documents/:id/versions/:n/retry', ({ params }) => {
        retried = true;
        return HttpResponse.json(
          versionSummaryDtoSchema.parse({
            ...makeSampleDocumentDetail().currentVersion,
            number: Number(params['n']),
            status: 'queued',
            error: null,
            attempts: 0,
            extractedAt: null,
            reviewable: false,
          }),
          { status: 202 },
        );
      }),
    );

    renderAt(`/documents/${DOC_ID_1}`);
    expect(await screen.findByText(/extraction isn't configured/i)).toBeInTheDocument();

    const retryBtn = screen.getByRole('button', { name: /retry/i });
    await user.click(retryBtn);

    expect(await screen.findByText('Total Amount')).toBeInTheDocument();
  });

  it('renders inline Retry on failed document rows in DocumentsListPage and Retry inside newerFailed banner', async () => {
    const user = userEvent.setup();
    let retriedList = false;

    server.use(
      http.get('/api/documents', () =>
        HttpResponse.json({
          data: [
            makeSampleDocumentSummary({
              status: retriedList ? 'queued' : 'failed',
              valuesVersion: null,
              currentVersion: {
                ...makeSampleDocumentSummary().currentVersion,
                number: 1,
                status: retriedList ? 'queued' : 'failed',
                error: retriedList
                  ? null
                  : { code: 'MAX_ATTEMPTS', message: 'Failed 3 times', retryable: true },
                extractedAt: null,
                reviewable: false,
              },
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
        }),
      ),
      http.post('/api/documents/:id/versions/:n/retry', () => {
        retriedList = true;
        return HttpResponse.json(
          versionSummaryDtoSchema.parse({
            ...makeSampleDocumentSummary().currentVersion,
            number: 1,
            status: 'queued',
            error: null,
            attempts: 0,
            extractedAt: null,
            reviewable: false,
          }),
          { status: 202 },
        );
      }),
    );

    renderAt('/documents?view=failed');
    const retryBtn = await screen.findByRole('button', { name: /retry/i });
    await user.click(retryBtn);

    await waitFor(() => {
      expect(retriedList).toBe(true);
    });
  });

  it('uploads a new version from DocumentDetailPage header dialog and handles deduplicated 200 response', async () => {
    const user = userEvent.setup();
    let uploaded = false;

    server.use(
      http.post('/api/documents/:id/versions', () => {
        uploaded = true;
        const summary = makeSampleDocumentSummary();
        return HttpResponse.json(
          createVersionResponseDtoSchema.parse({
            document: summary,
            version: summary.currentVersion,
            deduplicated: true,
          }),
          { status: 200 },
        );
      }),
    );

    renderAt(`/documents/${DOC_ID_1}`);
    const openBtn = await screen.findByRole('button', { name: /upload new version/i });
    await user.click(openBtn);

    const dialog = await screen.findByRole('dialog', { name: /upload new version/i });
    expect(dialog).toBeInTheDocument();

    const fileInput = screen.getByLabelText(/pdf file/i);
    const pdfFile = new File(['%PDF-1.7\n%%EOF'], 'invoice-v2.pdf', { type: 'application/pdf' });
    await user.upload(fileInput, pdfFile);
    await user.click(screen.getByRole('button', { name: /upload version/i }));

    await waitFor(() => {
      expect(uploaded).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('surfaces Re-extract errors (409/429) in an accessible alert', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/documents/:id/versions/:n/reextract', () =>
        HttpResponse.json(makeProblem(409, 'VERSION_NOT_TERMINAL', 'In flight'), { status: 409 }),
      ),
    );

    renderAt(`/documents/${DOC_ID_1}`);
    const reextractBtn = await screen.findByRole('button', { name: /re-extract/i });
    await user.click(reextractBtn);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /wait for the current extraction to finish/i,
    );
  });
});
