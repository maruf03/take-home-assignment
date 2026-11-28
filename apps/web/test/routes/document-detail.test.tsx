import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppRoutes } from '../../src/app/App.js';
import { DOC_ID_1, makeSampleDocumentDetail, server } from '../msw/handlers.js';

function renderDetail(initialEntry: string, pollMs = 50) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AppRoutes pollMs={pollMs} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DocumentDetailPage, TextPane, PDF download, and polling', () => {
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it('renders value groups strictly in order Changed -> Gaps -> Pending -> Done, hides LINE_HINT_MISMATCH, highlights text ranges, and links PDF download', async () => {
    const user = userEvent.setup();
    renderDetail(`/documents/${DOC_ID_1}`);

    // Wait for values & text to load
    expect(await screen.findByText('Total Amount')).toBeInTheDocument();

    // Check group heading order: Changed -> Gaps -> Needs review -> Done
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent ?? '');
    const changedIdx = headings.findIndex((t) => /changed/i.test(t));
    const gapsIdx = headings.findIndex((t) => /gaps/i.test(t));
    const pendingIdx = headings.findIndex((t) => /needs review/i.test(t));
    const doneIdx = headings.findIndex((t) => /done/i.test(t));
    expect(changedIdx).toBeGreaterThanOrEqual(0);
    expect(gapsIdx).toBeGreaterThan(changedIdx);
    expect(pendingIdx).toBeGreaterThan(gapsIdx);
    expect(doneIdx).toBeGreaterThan(pendingIdx);

    // LINE_HINT_MISMATCH is debug-only and never shown in the reviewer UI
    expect(screen.queryByText(/LINE_HINT_MISMATCH/i)).not.toBeInTheDocument();
    expect(screen.getByText(/very small or faint/i)).toBeInTheDocument();

    // Text pane highlights evidence from stored offsets (<mark>), other occurrences, hidden, and low-visibility
    const mark = await screen.findByTestId('active-evidence-mark');
    expect(mark.tagName).toBe('MARK');
    expect(mark).toHaveTextContent('Total Amount Due: $5,999.99');

    const otherOcc = screen.getByTestId('other-occurrence-span');
    expect(otherOcc).toHaveTextContent('$5,999.99');

    const hiddenSpan = screen.getByTestId('hidden-text-span');
    expect(hiddenSpan).toHaveTextContent('HIDDEN_OFFPAGE_INJECTION $0.00');
    expect(screen.getByText(/hidden in pdf/i)).toBeInTheDocument();

    const lowVisSpan = screen.getByTestId('low-visibility-span');
    expect(lowVisSpan).toHaveTextContent('Fine print disclaimer line');

    // PDF download link points to /api/documents/:id/versions/2/file
    const downloadLinks = screen.getAllByRole('link', { name: /download.*pdf/i });
    expect(downloadLinks.length).toBeGreaterThan(0);
    expect(downloadLinks[0]).toHaveAttribute('href', `/api/documents/${DOC_ID_1}/versions/2/file`);

    // Done group is collapsed by default and can be expanded
    expect(screen.queryByText('Vendor Name')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /done/i }));
    expect(await screen.findByText('Vendor Name')).toBeInTheDocument();
  });

  it('shows read-only banner on historical version route /documents/:id/versions/1', async () => {
    renderDetail(`/documents/${DOC_ID_1}/versions/1`);
    expect(await screen.findByText(/viewing v1 \(read-only\)/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to current/i })).toHaveAttribute(
      'href',
      `/documents/${DOC_ID_1}`,
    );
  });

  it('polls while extraction is in flight and stops polling once terminal (extracted)', async () => {
    let calls = 0;
    server.use(
      http.get('/api/documents/:id', () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(
            makeSampleDocumentDetail({
              status: 'queued',
              valuesVersion: null,
              values: [],
              valuesTextMeta: null,
              currentVersion: {
                ...makeSampleDocumentDetail().currentVersion,
                status: 'queued',
                extractedAt: null,
                reviewable: false,
              },
            }),
          );
        }
        if (calls === 2) {
          return HttpResponse.json(
            makeSampleDocumentDetail({
              status: 'extracting',
              valuesVersion: null,
              values: [],
              valuesTextMeta: null,
              currentVersion: {
                ...makeSampleDocumentDetail().currentVersion,
                status: 'extracting',
                extractedAt: null,
                reviewable: false,
              },
            }),
          );
        }
        return HttpResponse.json(makeSampleDocumentDetail());
      }),
    );

    renderDetail(`/documents/${DOC_ID_1}`, 40);

    // Reaches terminal extracted state after polling
    expect(await screen.findByText('Total Amount')).toBeInTheDocument();
    const settledCalls = calls;
    expect(settledCalls).toBeGreaterThanOrEqual(3);

    // Wait several poll intervals and confirm NO further polls fired
    await new Promise((r) => setTimeout(r, 200));
    await waitFor(() => {
      expect(calls).toBe(settledCalls);
    });
  });
});
