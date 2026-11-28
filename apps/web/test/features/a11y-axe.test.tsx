import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
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
        <AppRoutes pollMs={60_000} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function expectZeroSeriousAxeViolations(container: HTMLElement) {
  // color-contrast requires canvas/computed layout unavailable in jsdom; checked in Playwright e2e.
  const results = await axe.run(container, {
    rules: {
      'color-contrast': { enabled: false },
    },
  });
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious).toEqual([]);
}

describe('Accessibility (axe-core) across UI states', () => {
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it('has zero serious/critical axe violations on DocumentsListPage (populated, failed with Retry, and empty)', async () => {
    const { container, unmount } = renderAt('/documents?view=needs-review');
    await screen.findByText('Invoice — Meridian Office Supplies');
    await expectZeroSeriousAxeViolations(container);
    unmount();

    server.use(
      http.get('/api/documents', () =>
        HttpResponse.json({
          data: [
            makeSampleDocumentSummary({
              status: 'failed',
              valuesVersion: null,
              currentVersion: {
                ...makeSampleDocumentSummary().currentVersion,
                status: 'failed',
                error: { code: 'LLM_NOT_CONFIGURED', message: 'No key', retryable: true },
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
    );
    const failedView = renderAt('/documents?view=failed');
    await screen.findByRole('button', { name: /retry/i });
    await expectZeroSeriousAxeViolations(failedView.container);
    failedView.unmount();

    server.use(
      http.get('/api/documents', () =>
        HttpResponse.json({
          data: [],
          page: { limit: 20, hasMore: false, nextCursor: null },
        }),
      ),
    );
    const emptyView = renderAt('/documents?view=needs-review');
    await screen.findByText(/all caught up/i);
    await expectZeroSeriousAxeViolations(emptyView.container);
    emptyView.unmount();
  });

  it('has zero serious/critical axe violations on DocumentDetailPage (all groups, inline CorrectionForm, conflict card, failed panel, and historical view)', async () => {
    const user = userEvent.setup();
    const { container, unmount } = renderAt(`/documents/${DOC_ID_1}`);
    const moneyRow = await screen.findByRole('group', { name: 'Total Amount' });
    await expectZeroSeriousAxeViolations(container);

    // Open inline CorrectionForm + validation error state
    await user.click(within(moneyRow).getByRole('button', { name: /^correct$/i }));
    const amountInput = await within(moneyRow).findByLabelText(/amount/i);
    await user.clear(amountInput);
    await user.click(within(moneyRow).getByRole('button', { name: /^save$/i }));
    await expectZeroSeriousAxeViolations(container);
    await user.click(within(moneyRow).getByRole('button', { name: /^cancel$/i }));

    // Open Date CorrectionForm + expanded Done group + UploadVersionDialog
    const dateRow = screen.getByRole('group', { name: 'Issue Date' });
    await user.click(within(dateRow).getByRole('button', { name: /^correct$/i }));
    await expectZeroSeriousAxeViolations(container);
    await user.click(within(dateRow).getByRole('button', { name: /^cancel$/i }));

    await user.click(screen.getByRole('button', { name: /show done/i }));
    await expectZeroSeriousAxeViolations(container);

    await user.click(screen.getByRole('button', { name: /upload new version/i }));
    await screen.findByRole('dialog', { name: /upload new version/i });
    await expectZeroSeriousAxeViolations(container);
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    // Trigger REVIEW_CONFLICT inline card
    server.use(
      http.post('/api/values/:id/review', () =>
        HttpResponse.json(makeProblem(409, 'REVIEW_CONFLICT', 'Conflict'), { status: 409 }),
      ),
    );
    await user.click(within(moneyRow).getByRole('button', { name: /^approve$/i }));
    await screen.findByRole('alert');
    await expectZeroSeriousAxeViolations(container);
    unmount();

    // Failed detail panel with Retry
    server.use(
      http.get('/api/documents/:id', () => {
        const base = makeSampleDocumentDetail();
        return HttpResponse.json({
          ...base,
          status: 'failed',
          valuesVersion: null,
          values: [],
          valuesTextMeta: null,
          currentVersion: {
            ...base.currentVersion,
            status: 'failed',
            error: { code: 'LLM_NOT_CONFIGURED', message: 'No key', retryable: true },
            extractedAt: null,
            reviewable: false,
          },
        });
      }),
    );
    const failedDetail = renderAt(`/documents/${DOC_ID_1}`);
    await screen.findByRole('button', { name: /retry/i });
    await expectZeroSeriousAxeViolations(failedDetail.container);
    failedDetail.unmount();

    // Historical read-only view
    server.resetHandlers();
    const histView = renderAt(`/documents/${DOC_ID_1}/versions/1`);
    await screen.findByText(/viewing v1 \(read-only\)/i);
    await expectZeroSeriousAxeViolations(histView.container);
    histView.unmount();
  });
});
