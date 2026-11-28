import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppRoutes } from '../../src/app/App.js';
import {
  DOC_ID_1,
  makeSampleDocumentDetail,
  makeSampleVersionDetail,
  server,
} from '../msw/handlers.js';

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

    // Keyboard-accessible selection button switches active evidence and preserves overlapping lowVisibility class
    const issueDateBtn = screen.getByRole('button', { name: /issue date/i });
    await user.click(issueDateBtn);
    const activeIssueMark = await screen.findByTestId('active-evidence-mark');
    expect(activeIssueMark).toHaveTextContent('Fine print disclaimer line');
    expect(activeIssueMark.className).toContain('text-low-visibility');

    // PDF download link points to /api/documents/:id/versions/2/file
    const downloadLinks = screen.getAllByRole('link', { name: /download.*pdf/i });
    expect(downloadLinks.length).toBeGreaterThan(0);
    expect(downloadLinks[0]).toHaveAttribute('href', `/api/documents/${DOC_ID_1}/versions/2/file`);

    // Done group is collapsed by default and can be expanded
    expect(screen.queryByText('Vendor Name')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /done/i }));
    expect(await screen.findByText('Vendor Name')).toBeInTheDocument();
  });

  it('shows read-only banner on historical version route /documents/:id/versions/1 and renders fallback option when outside recentVersions', async () => {
    const base = makeSampleDocumentDetail();
    server.use(
      http.get('/api/documents/:id', () =>
        HttpResponse.json({
          ...base,
          recentVersions: [base.currentVersion], // v1 omitted (>5 versions case)
          versionsCount: 6,
        }),
      ),
    );
    renderDetail(`/documents/${DOC_ID_1}/versions/1`);
    expect(await screen.findByText(/viewing v1 \(read-only\)/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to current/i })).toHaveAttribute(
      'href',
      `/documents/${DOC_ID_1}`,
    );
    const picker = screen.getByLabelText(/version picker/i);
    expect(picker).toHaveValue('1');
  });

  it('allows switching to a newer failed currentVersion and shows its failure details without rendering raw placeholders', async () => {
    const user = userEvent.setup();
    const base = makeSampleDocumentDetail();
    const failedV2 = {
      ...base.currentVersion,
      number: 2,
      status: 'failed' as const,
      error: { code: 'PARSE_NO_TEXT' as const, message: 'No text layer', retryable: false },
      extractedAt: null,
      reviewable: false,
    };
    const detailWithNewerFailed = makeSampleDocumentDetail({
      valuesVersion: 1,
      currentVersion: failedV2,
      recentVersions: [failedV2, base.recentVersions[1]!],
      values: base.values.map((v) =>
        v.kind === 'gap'
          ? {
              ...v,
              gap: {
                code: 'CONFLICTING_EVIDENCE' as const,
                reason: 'Line 2 says $100, line 5 says $200',
                attemptedQuote: null,
              },
            }
          : v,
      ),
    });

    let textRequestsForV2 = 0;
    server.use(
      http.get('/api/documents/:id', () => HttpResponse.json(detailWithNewerFailed)),
      http.get('/api/documents/:id/versions/2', () =>
        HttpResponse.json({
          ...makeSampleVersionDetail(1),
          ...failedV2,
          values: [],
          textRanges: null,
          pageOffsets: null,
        }),
      ),
      http.get('/api/documents/:id/versions/2/text', () => {
        textRequestsForV2 += 1;
        return HttpResponse.json(
          {
            type: 'about:blank',
            title: 'TEXT_NOT_AVAILABLE',
            status: 409,
            code: 'TEXT_NOT_AVAILABLE',
            detail: 'No parsed text',
            requestId: 'req-1',
          },
          { status: 409 },
        );
      }),
    );

    renderDetail(`/documents/${DOC_ID_1}`);
    expect(await screen.findByText(/version v2 failed/i)).toBeInTheDocument();
    // CONFLICTING_EVIDENCE must not show raw {v1}/{v2} tokens
    expect(screen.queryByText(/\{v1\}/)).not.toBeInTheDocument();
    expect(screen.getByText(/line 2 says \$100, line 5 says \$200/i)).toBeInTheDocument();

    // Switching version picker to v2 navigates to /versions/2 and renders failed panel
    const picker = screen.getByLabelText(/version picker/i);
    await user.selectOptions(picker, '2');
    expect(await screen.findByRole('heading', { name: /extraction failed/i })).toBeInTheDocument();
    expect(screen.getByText(/this pdf has no text layer/i)).toBeInTheDocument();
    expect(textRequestsForV2).toBe(0);
  });

  it('virtualizes >2,000-line documents and mounts target line for #L2500 deep links', async () => {
    const bigText = Array.from({ length: 2600 }, (_, i) => `Document line ${i + 1}`).join('\n');
    server.use(
      http.get('/api/documents/:id/versions/:n/text', () =>
        HttpResponse.text(bigText, {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        }),
      ),
    );

    renderDetail(`/documents/${DOC_ID_1}#L2500`);
    expect(await screen.findByText('Document line 2500')).toBeInTheDocument();
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

  it('[I11] keeps row order frozen after approve until Re-sort, shows 8s Undo toast that posts revert, and supports keyboard shortcuts with toggle', async () => {
    const user = userEvent.setup();
    const requests: Array<{ decision: string; expectedCurrentReviewId?: string | null }> = [];
    let currentDetail = makeSampleDocumentDetail();

    server.use(
      http.get(`/api/documents/${DOC_ID_1}`, () => HttpResponse.json(currentDetail)),
      http.post('/api/values/:valueId/review', async ({ params, request }) => {
        const body = (await request.json()) as {
          decision: 'approve' | 'correct' | 'revert';
          expectedCurrentReviewId?: string | null;
        };
        requests.push({
          decision: body.decision,
          expectedCurrentReviewId: body.expectedCurrentReviewId,
        });
        const target = currentDetail.values.find((v) => v.id === params['valueId'])!;
        const nextReview = {
          id:
            body.decision === 'revert'
              ? '01950000-0000-7000-8000-000000000999'
              : '01950000-0000-7000-8000-000000000888',
          decision: body.decision,
          correctedValue: null,
          note: null,
          origin: 'human' as const,
          carriedFromVersion: null,
          createdAt: '2026-11-27T12:05:00.000Z',
        };
        const updatedValue = {
          ...target,
          reviewState: body.decision === 'revert' ? ('pending' as const) : ('approved' as const),
          attention: body.decision === 'revert' ? ('changed' as const) : ('done' as const),
          review: nextReview,
        };
        currentDetail = {
          ...currentDetail,
          values: currentDetail.values.map((v) => (v.id === target.id ? updatedValue : v)),
        };
        return HttpResponse.json({
          value: updatedValue,
          progress: currentDetail.progress,
        });
      }),
    );

    renderDetail(`/documents/${DOC_ID_1}`);
    expect(await screen.findByText('Total Amount')).toBeInTheDocument();

    // Press '?' to open shortcuts dialog, then Esc to close
    await user.keyboard('?');
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument();

    // Enable Freeze order, then press 'a' to approve first selected value ('Total Amount')
    await user.click(screen.getByRole('button', { name: /Freeze order: Off/i }));
    expect(screen.getByRole('button', { name: /Freeze order: On/i })).toBeInTheDocument();
    await user.keyboard('a');
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(requests[0]?.decision).toBe('approve');

    // Row order stays frozen so Re-sort button appears
    const resortBtn = await screen.findByRole('button', { name: 'Re-sort' });
    expect(resortBtn).toBeInTheDocument();

    // Click Undo in the toast -> posts decision:'revert'
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(requests[1]).toEqual({
      decision: 'revert',
      expectedCurrentReviewId: '01950000-0000-7000-8000-000000000888',
    });

    // Shortcuts are inert inside <input> (typing 'a' in note input does NOT fire approve)
    await user.keyboard('c');
    const noteInput = await screen.findByLabelText(/Note/i);
    await user.click(noteInput);
    await user.keyboard('a');
    expect(requests).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // Toggle shortcuts off -> pressing 'a' no longer triggers approve
    await user.click(screen.getByRole('button', { name: /Shortcuts: On/i }));
    expect(screen.getByRole('button', { name: /Shortcuts: Off/i })).toBeInTheDocument();
    await user.keyboard('a');
    expect(requests).toHaveLength(2);
  });
});
