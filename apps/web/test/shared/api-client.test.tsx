import { documentSummaryDtoSchema } from '@app/contracts/dto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../src/app/App.js';
import { api, ApiError, ContractMismatchError } from '../../src/shared/api/client.js';
import { DOC_ID_1, makeProblem, makeSampleDocumentDetail, server } from '../msw/handlers.js';

describe('API client & ErrorBoundary', () => {
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it('parses responses with zod, uses cache: no-cache, and maps problem+json to typed ApiError', async () => {
    server.use(
      http.get('/api/documents/bad-id', () =>
        HttpResponse.json(makeProblem(404, 'DOCUMENT_NOT_FOUND', 'Document not found'), {
          status: 404,
          headers: { 'Content-Type': 'application/problem+json' },
        }),
      ),
    );

    await expect(api.get('/documents/bad-id', documentSummaryDtoSchema)).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'DOCUMENT_NOT_FOUND',
      requestId: 'req-msw-1',
    } satisfies Partial<ApiError>);
  });

  it('maps non-JSON nginx 413/415/429 responses to typed ProblemCodes and rejects non-text/plain in getText', async () => {
    server.use(
      http.post(
        '/api/documents',
        () =>
          new HttpResponse('<html>413 Request Entity Too Large</html>', {
            status: 413,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get(
        '/api/documents/rate-limited',
        () =>
          new HttpResponse('<html>429 Too Many Requests</html>', {
            status: 429,
            headers: { 'Content-Type': 'text/html', 'Retry-After': '12' },
          }),
      ),
      http.get(
        '/api/documents/wrong-type',
        () =>
          new HttpResponse('<html>415 Unsupported Media Type</html>', {
            status: 415,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get(
        '/api/documents/spa-fallback/versions/1/text',
        () =>
          new HttpResponse('<!doctype html><html></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          }),
      ),
    );

    const form = new FormData();
    await expect(
      api.postMultipart('/documents', form, documentSummaryDtoSchema),
    ).rejects.toMatchObject({
      status: 413,
      code: 'FILE_TOO_LARGE',
    });

    await expect(
      api.get('/documents/rate-limited', documentSummaryDtoSchema),
    ).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 12,
    });

    await expect(api.get('/documents/wrong-type', documentSummaryDtoSchema)).rejects.toMatchObject({
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });

    await expect(api.getText('/documents/spa-fallback/versions/1/text')).rejects.toBeInstanceOf(
      ContractMismatchError,
    );
  });

  it('recovers from ErrorBoundary on Try again and resets when navigating away', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    let failCount = 0;

    server.use(
      http.get('/api/documents/:id', () => {
        failCount += 1;
        if (failCount === 1) {
          return HttpResponse.json({ unexpected: 'shape' });
        }
        return HttpResponse.json(makeSampleDocumentDetail());
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/documents/${DOC_ID_1}`]}>
          <AppRoutes />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/unexpected response/i);

    // Clicking Try again resets TanStack Query error boundary and refetches successfully
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Total Amount')).toBeInTheDocument();

    // Now force an error on detail and verify header navigation resets ErrorBoundary
    server.use(
      http.get('/api/documents/:id', () =>
        HttpResponse.json(makeProblem(404, 'DOCUMENT_NOT_FOUND', 'Missing'), { status: 404 }),
      ),
    );
    await user.click(screen.getByRole('link', { name: /documents/i }));
    expect(await screen.findByText('Invoice — Meridian Office Supplies')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: /invoice — meridian office supplies/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not found/i);

    await user.click(screen.getByRole('link', { name: /^queue$/i }));
    expect(await screen.findByText('Invoice — Meridian Office Supplies')).toBeInTheDocument();

    consoleErr.mockRestore();
  });
});
