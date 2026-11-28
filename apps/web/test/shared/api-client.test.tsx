import { documentSummaryDtoSchema } from '@app/contracts/dto';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api, ApiError, ContractMismatchError } from '../../src/shared/api/client.js';
import { ErrorBoundary } from '../../src/shared/ui/ErrorBoundary.js';
import { makeProblem, server } from '../msw/handlers.js';

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

  it('throws ContractMismatchError on schema mismatch and renders ErrorBoundary fallback', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    server.use(
      http.get('/api/documents/corrupt', () =>
        HttpResponse.json({ unexpected: 'shape', missing: true }),
      ),
    );

    await expect(api.get('/documents/corrupt', documentSummaryDtoSchema)).rejects.toBeInstanceOf(
      ContractMismatchError,
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    function CorruptConsumer() {
      const q = useQuery({
        queryKey: ['corrupt'],
        queryFn: () => api.get('/documents/corrupt', documentSummaryDtoSchema),
        throwOnError: true,
      });
      return <div>{q.data?.title}</div>;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <CorruptConsumer />
        </ErrorBoundary>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/unexpected response/i);
    consoleErr.mockRestore();
  });
});
