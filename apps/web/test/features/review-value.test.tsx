import {
  reviewResponseDtoSchema,
  type DocumentDetailDto,
  type ValueViewDto,
} from '@app/contracts/dto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppRoutes } from '../../src/app/App.js';
import {
  DOC_ID_1,
  makeProblem,
  makeSampleDocumentDetail,
  server,
  VAL_CHANGED_ID,
  VAL_GAP_ID,
  VAL_PENDING_ID,
} from '../msw/handlers.js';

function renderDetail(initialEntry = `/documents/${DOC_ID_1}`) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AppRoutes pollMs={50} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Review value actions, states, flags, correction forms, and optimistic updates', () => {
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it('[R8] ValueRow.changed renders previous value, previous quote, previous review, and token-level diff alongside Approve/Correct', async () => {
    renderDetail();

    const changedGroup = await screen.findByRole('group', { name: 'Total Amount' });
    // Previous value struck through and previous review decision/note visible
    expect(within(changedGroup).getByText(/v1: \$5,230\.29/)).toBeInTheDocument();
    expect(within(changedGroup).getByText(/checked v1/i)).toBeInTheDocument();
    expect(within(changedGroup).getByText(/previous \(v1\)/i)).toBeInTheDocument();

    // Token-level diff renders <del> for removed previous token and <ins> for added current token
    const removed = changedGroup.querySelector('del');
    const added = changedGroup.querySelector('ins');
    expect(removed).not.toBeNull();
    expect(removed?.textContent).toContain('$5,230.29');
    expect(added).not.toBeNull();
    expect(added?.textContent).toContain('$5,999.99');

    expect(within(changedGroup).getByRole('button', { name: /^approve$/i })).toBeInTheDocument();
    expect(within(changedGroup).getByRole('button', { name: /^correct$/i })).toBeInTheDocument();
  });

  it('renders every ValueRow state (pending, changed, carried, approved, corrected, gap with attemptedQuote) and all 7 reviewer flags while hiding LINE_HINT_MISMATCH', async () => {
    const user = userEvent.setup();
    const base = makeSampleDocumentDetail();
    const allStatesDetail: DocumentDetailDto = {
      ...base,
      values: [
        ...base.values.map((v) =>
          v.id === VAL_GAP_ID
            ? {
                ...v,
                gap: {
                  code: 'EVIDENCE_NOT_IN_TEXT' as const,
                  reason: 'Quote did not match document text',
                  attemptedQuote: 'Invoice #99999',
                },
              }
            : v.id === VAL_PENDING_ID
              ? {
                  ...v,
                  flags: [
                    'LOW_VISIBILITY',
                    'AMBIGUOUS_OCCURRENCE',
                    'TOKEN_AMBIGUOUS',
                    'AMBIGUOUS_DATE',
                    'QUOTE_FOLDED',
                    'WEAK_EVIDENCE_LINE',
                    'CONFLICTING_LINES',
                    'LINE_HINT_MISMATCH',
                  ] as ValueViewDto['flags'],
                }
              : v,
        ),
        {
          id: '01950000-0000-7000-8000-000000000105',
          fieldKey: 'tax_rate',
          label: 'Tax Rate',
          fieldType: 'percent',
          position: 5,
          kind: 'value',
          value: '8.5',
          effectiveValue: '9.25',
          evidence: null,
          gap: null,
          flags: [],
          changeKind: 'same',
          changeReason: null,
          reviewState: 'corrected',
          attention: 'done',
          review: {
            id: '01950000-0000-7000-8000-000000000205',
            decision: 'correct',
            correctedValue: '9.25',
            note: 'Adjusted per addendum',
            origin: 'human',
            carriedFromVersion: null,
            createdAt: '2026-11-27T10:15:00.000Z',
          },
          previous: null,
          reviewable: true,
        },
        {
          id: '01950000-0000-7000-8000-000000000106',
          fieldKey: 'seat_count',
          label: 'Seat Count',
          fieldType: 'number',
          position: 6,
          kind: 'value',
          value: '24',
          effectiveValue: '24',
          evidence: null,
          gap: null,
          flags: [],
          changeKind: 'same',
          changeReason: null,
          reviewState: 'approved',
          attention: 'done',
          review: {
            id: '01950000-0000-7000-8000-000000000206',
            decision: 'approve',
            correctedValue: null,
            note: null,
            origin: 'human',
            carriedFromVersion: null,
            createdAt: '2026-11-27T10:16:00.000Z',
          },
          previous: null,
          reviewable: true,
        },
      ],
    };

    server.use(http.get('/api/documents/:id', () => HttpResponse.json(allStatesDetail)));
    renderDetail();

    // Gap row has Confirm not present, Enter value, and attemptedQuote
    const gapRow = await screen.findByRole('group', { name: 'Invoice Number' });
    expect(
      within(gapRow).getByRole('button', { name: /confirm not present/i }),
    ).toBeInTheDocument();
    expect(within(gapRow).getByRole('button', { name: /enter value/i })).toBeInTheDocument();
    expect(within(gapRow).getByText(/invoice #99999/i)).toBeInTheDocument();

    // All 7 reviewer flags rendered, LINE_HINT_MISMATCH hidden
    const pendingRow = screen.getByRole('group', { name: 'Issue Date' });
    expect(within(pendingRow).getByText(/very small or faint/i)).toBeInTheDocument();
    expect(within(pendingRow).getByText(/multiple lines/i)).toBeInTheDocument();
    expect(within(pendingRow).getByText(/multiple candidate values/i)).toBeInTheDocument();
    expect(within(pendingRow).getByText(/date format is ambiguous/i)).toBeInTheDocument();
    expect(within(pendingRow).getByText(/curly quotation marks/i)).toBeInTheDocument();
    expect(within(pendingRow).getByText(/no surrounding label/i)).toBeInTheDocument();
    expect(within(pendingRow).getByText(/same label has a different value/i)).toBeInTheDocument();
    expect(within(pendingRow).queryByText(/different line number/i)).not.toBeInTheDocument();

    // Expand Done to check Carried, Approved, and Corrected rows with Change decision button
    await user.click(screen.getByRole('button', { name: /show done/i }));
    const carriedRow = await screen.findByRole('group', { name: 'Vendor Name' });
    expect(within(carriedRow).getByText(/carried from v1, approved/i)).toBeInTheDocument();
    expect(
      within(carriedRow).getByRole('button', { name: /change decision/i }),
    ).toBeInTheDocument();
    // Critical #4: unchanged carried_over row with previous !== null must NOT show Changed comparison
    expect(within(carriedRow).queryByText(/previous \(v1\)/i)).not.toBeInTheDocument();
    expect(within(carriedRow).queryByText(/v1: Meridian Office Supplies/i)).not.toBeInTheDocument();

    const correctedRow = screen.getByRole('group', { name: 'Tax Rate' });
    expect(within(correctedRow).getByText('9.25%')).toBeInTheDocument();
    expect(within(correctedRow).getByText('8.5%')).toBeInTheDocument();
    expect(within(correctedRow).getByText(/adjusted per addendum/i)).toBeInTheDocument();
    expect(
      within(correctedRow).getByRole('button', { name: /change decision/i }),
    ).toBeInTheDocument();

    const approvedRow = screen.getByRole('group', { name: 'Seat Count' });
    expect(within(approvedRow).getByText('Approved')).toBeInTheDocument();
  });

  it('renders type-specific correction forms (money, date, number, percent, string) with live canonical preview and submits corrected payload', async () => {
    const user = userEvent.setup();
    const base = makeSampleDocumentDetail();
    const typedDetail: DocumentDetailDto = {
      ...base,
      values: [
        ...base.values,
        {
          id: '01950000-0000-7000-8000-000000000107',
          fieldKey: 'rate_pct',
          label: 'Escalation Rate',
          fieldType: 'percent',
          position: 5,
          kind: 'value',
          value: '4.2',
          effectiveValue: '4.2',
          evidence: null,
          gap: null,
          flags: [],
          changeKind: 'new',
          changeReason: null,
          reviewState: 'pending',
          attention: 'pending',
          review: null,
          previous: null,
          reviewable: true,
        },
        {
          id: '01950000-0000-7000-8000-000000000108',
          fieldKey: 'units_num',
          label: 'Units',
          fieldType: 'number',
          position: 6,
          kind: 'value',
          value: '10',
          effectiveValue: '10',
          evidence: null,
          gap: null,
          flags: [],
          changeKind: 'new',
          changeReason: null,
          reviewState: 'pending',
          attention: 'pending',
          review: null,
          previous: null,
          reviewable: true,
        },
      ],
    };

    let lastReviewBody: unknown = null;
    server.use(
      http.get('/api/documents/:id', () => HttpResponse.json(typedDetail)),
      http.post('/api/values/:id/review', async ({ params, request }) => {
        lastReviewBody = await request.json();
        const target = typedDetail.values.find((v) => v.id === params['id'])!;
        return HttpResponse.json(
          reviewResponseDtoSchema.parse({
            value: {
              ...target,
              reviewState: 'corrected',
              attention: 'done',
              effectiveValue: { amount: '5230.29', currency: 'USD' },
              review: {
                id: '01950000-0000-7000-8000-000000000902',
                decision: 'correct',
                correctedValue: { amount: '5230.29', currency: 'USD' },
                note: 'Per page 2 total',
                origin: 'human',
                carriedFromVersion: null,
                createdAt: '2026-11-27T11:00:00.000Z',
              },
            },
            progress: {
              ...typedDetail.progress,
              pending: typedDetail.progress.pending - 1,
              corrected: 1,
            },
          }),
          { status: 201 },
        );
      }),
    );

    renderDetail();

    // 1. Money form: accepts $5,230.29, shows canonical preview, submits { amount, currency }
    const moneyRow = await screen.findByRole('group', { name: 'Total Amount' });
    await user.click(within(moneyRow).getByRole('button', { name: /^correct$/i }));
    const amountInput = within(moneyRow).getByLabelText(/amount/i);
    await user.clear(amountInput);
    await user.type(amountInput, '$5,230.29');
    expect(within(moneyRow).getByTestId('canonical-preview')).toHaveTextContent(
      /will save as: \$5,230\.29/i,
    );
    const noteInput = within(moneyRow).getByLabelText(/note/i);
    await user.type(noteInput, 'Per page 2 total');
    await user.click(within(moneyRow).getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(lastReviewBody).toEqual({
        decision: 'correct',
        correctedValue: { amount: '5230.29', currency: 'USD' },
        note: 'Per page 2 total',
        expectedCurrentReviewId: null,
      });
    });
    // Critical #1: saved correction must settle cleanly even when parsed text is cached (no TypeError rollback)
    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Total Amount' })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // 2. Date form: shows date in words ("Thu, 13 Nov 2025")
    const dateRow = screen.getByRole('group', { name: 'Issue Date' });
    await user.click(within(dateRow).getByRole('button', { name: /^correct$/i }));
    const dateInput = within(dateRow).getByLabelText(/date value/i);
    await user.clear(dateInput);
    await user.type(dateInput, '2025-11-13');
    expect(within(dateRow).getByText(/thu, 13 nov 2025/i)).toBeInTheDocument();
    await user.click(within(dateRow).getByRole('button', { name: /^cancel$/i }));

    // 3. Percent form: shows "4.2, not 0.042" hint and canonical preview
    const pctRow = screen.getByRole('group', { name: 'Escalation Rate' });
    await user.click(within(pctRow).getByRole('button', { name: /^correct$/i }));
    expect(within(pctRow).getByText(/4\.2, not 0\.042/i)).toBeInTheDocument();
    await user.click(within(pctRow).getByRole('button', { name: /^cancel$/i }));

    // 4. Number form: inputMode="decimal"
    const numRow = screen.getByRole('group', { name: 'Units' });
    await user.click(within(numRow).getByRole('button', { name: /^correct$/i }));
    expect(within(numRow).getByLabelText(/value/i)).toHaveAttribute('inputmode', 'decimal');
    await user.click(within(numRow).getByRole('button', { name: /^cancel$/i }));

    // 5. String gap form: "Enter value" opens string editor
    const strRow = screen.getByRole('group', { name: 'Invoice Number' });
    await user.click(within(strRow).getByRole('button', { name: /enter value/i }));
    const strInput = within(strRow).getByLabelText(/value/i);
    await user.type(strInput, 'INV-2025-001');
    expect(within(strRow).getByTestId('canonical-preview')).toHaveTextContent(
      /will save as: INV-2025-001/i,
    );
  });

  it('applies optimistic update on approve and rolls back cleanly on server error', async () => {
    const user = userEvent.setup();
    let rejectPending!: () => void;
    const gate = new Promise<void>((resolve) => {
      rejectPending = resolve;
    });

    server.use(
      http.post('/api/values/:id/review', async () => {
        await gate;
        return HttpResponse.json(makeProblem(500, 'INTERNAL', 'Database error'), { status: 500 });
      }),
    );

    renderDetail();

    const changedRow = await screen.findByRole('group', { name: 'Total Amount' });
    await user.click(within(changedRow).getByRole('button', { name: /^approve$/i }));

    // Optimistic update immediately removes Total Amount from Changed (moves to collapsed Done)
    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Total Amount' })).not.toBeInTheDocument();
    });

    // Release 500 error -> optimistic state rolls back and Total Amount reappears in Changed
    rejectPending();
    expect(await screen.findByRole('group', { name: 'Total Amount' })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
  });

  it('handles 409 REVIEW_CONFLICT by refetching detail, keeping ConflictCard visible even when value moves to Done, formatting reviewState, and preserving correction draft', async () => {
    const user = userEvent.setup();
    let detailFetches = 0;
    const base = makeSampleDocumentDetail();
    const conflictCurrentValue: ValueViewDto = {
      ...base.values.find((v) => v.id === VAL_CHANGED_ID)!,
      reviewState: 'carried_over',
      attention: 'done',
      effectiveValue: { amount: '6000', currency: 'USD' },
      review: {
        id: '01950000-0000-7000-8000-000000000888',
        decision: 'correct',
        correctedValue: { amount: '6000', currency: 'USD' },
        note: 'Reviewed by another tab',
        origin: 'carried',
        carriedFromVersion: 1,
        createdAt: '2026-11-27T11:05:00.000Z',
      },
    };

    server.use(
      http.get('/api/documents/:id', () => {
        detailFetches += 1;
        if (detailFetches >= 2) {
          return HttpResponse.json({
            ...base,
            values: base.values.map((v) => (v.id === VAL_CHANGED_ID ? conflictCurrentValue : v)),
          });
        }
        return HttpResponse.json(base);
      }),
      http.post('/api/values/:id/review', () =>
        HttpResponse.json(
          makeProblem(409, 'REVIEW_CONFLICT', 'Stale review version', {
            details: { currentValue: conflictCurrentValue },
          }),
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    renderDetail();
    const changedRow = await screen.findByRole('group', { name: 'Total Amount' });
    await user.click(within(changedRow).getByRole('button', { name: /^correct$/i }));
    const amountInput = within(changedRow).getByLabelText(/amount/i);
    await user.clear(amountInput);
    await user.type(amountInput, '5888.88');
    const fetchesBefore = detailFetches;

    await user.click(within(changedRow).getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(detailFetches).toBeGreaterThan(fetchesBefore);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/another review was saved first/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/carried over/i);
    expect(screen.getByRole('alert')).not.toHaveTextContent(/carried_over/);
    expect(screen.getAllByText(/\$6,000\.00/).length).toBeGreaterThan(0);
    const reloadedRow = screen.getByRole('group', { name: 'Total Amount' });
    expect(within(reloadedRow).getByLabelText(/amount/i)).toHaveValue('5888.88');
  });

  it('rolls back only the failed value when two reviews run concurrently and clears 422 error on edit', async () => {
    const user = userEvent.setup();
    let releaseFirstFail!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirstFail = resolve;
    });

    server.use(
      http.post('/api/values/:id/review', async ({ params, request }) => {
        const body = (await request.json()) as { decision: 'approve' | 'correct' };
        if (params['id'] === VAL_CHANGED_ID) {
          if (body.decision === 'correct') {
            return HttpResponse.json(
              makeProblem(422, 'INVALID_CORRECTION', 'Amount out of range', {
                errors: [{ path: 'correctedValue', message: 'Amount out of range' }],
              }),
              { status: 422 },
            );
          }
          await firstGate;
          return HttpResponse.json(makeProblem(500, 'INTERNAL', 'Transient fail'), { status: 500 });
        }
        const detail = makeSampleDocumentDetail();
        const existing = detail.values.find((v) => v.id === params['id'])!;
        return HttpResponse.json(
          reviewResponseDtoSchema.parse({
            value: {
              ...existing,
              reviewState: 'approved',
              attention: 'done',
              review: {
                id: '01950000-0000-7000-8000-000000000909',
                decision: 'approve',
                correctedValue: null,
                note: null,
                origin: 'human',
                carriedFromVersion: null,
                createdAt: '2026-11-27T11:00:00.000Z',
              },
            },
            progress: {
              ...detail.progress,
              pending: detail.progress.pending - 1,
              approved: detail.progress.approved + 1,
            },
          }),
          { status: 201 },
        );
      }),
    );

    renderDetail();
    // Wait for parsed text too so cache has documents.text string
    await screen.findByTestId('active-evidence-mark');

    // First verify 422 INVALID_CORRECTION clears when editing input
    const moneyRow = screen.getByRole('group', { name: 'Total Amount' });
    await user.click(within(moneyRow).getByRole('button', { name: /^correct$/i }));
    await user.click(within(moneyRow).getByRole('button', { name: /^save$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/amount out of range/i);
    await user.type(within(moneyRow).getByLabelText(/note/i), 'x');
    await waitFor(() => {
      expect(screen.queryByText(/amount out of range/i)).not.toBeInTheDocument();
    });
    await user.click(within(moneyRow).getByRole('button', { name: /^cancel$/i }));

    // Now approve Total Amount (in-flight -> will fail 500) and concurrently Confirm not present on Invoice Number (succeeds 201)
    await user.click(
      within(screen.getByRole('group', { name: 'Total Amount' })).getByRole('button', {
        name: /^approve$/i,
      }),
    );
    await user.click(
      within(screen.getByRole('group', { name: 'Invoice Number' })).getByRole('button', {
        name: /confirm not present/i,
      }),
    );

    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Invoice Number' })).not.toBeInTheDocument();
    });

    // Release Total Amount failure -> ONLY Total Amount rolls back; Invoice Number stays Done!
    releaseFirstFail();
    expect(await screen.findByRole('group', { name: 'Total Amount' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Invoice Number' })).not.toBeInTheDocument();
  });

  it('handles 409 VERSION_NOT_REVIEWABLE by showing a banner, refetching, and preserving correction draft even when field is in Done', async () => {
    const user = userEvent.setup();
    let versionNum = 2;

    server.use(
      http.get('/api/documents/:id', () => {
        const base = makeSampleDocumentDetail();
        return HttpResponse.json({
          ...base,
          valuesVersion: versionNum,
          currentVersion: { ...base.currentVersion, number: versionNum },
          values:
            versionNum === 3
              ? base.values.map((v) =>
                  v.id === VAL_CHANGED_ID
                    ? {
                        ...v,
                        id: '01950000-0000-7000-8000-000000000999',
                        attention: 'done',
                        reviewState: 'carried_over',
                      }
                    : v,
                )
              : base.values,
        });
      }),
      http.post('/api/values/:id/review', () => {
        versionNum = 3;
        return HttpResponse.json(makeProblem(409, 'VERSION_NOT_REVIEWABLE', 'Version superseded'), {
          status: 409,
          headers: { 'Content-Type': 'application/problem+json' },
        });
      }),
    );

    renderDetail();
    const moneyRow = await screen.findByRole('group', { name: 'Total Amount' });
    await user.click(within(moneyRow).getByRole('button', { name: /^correct$/i }));
    const amountInput = within(moneyRow).getByLabelText(/amount/i);
    await user.clear(amountInput);
    await user.type(amountInput, '6123.45');
    await user.click(within(moneyRow).getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/a newer version became reviewable/i)).toBeInTheDocument();
    await waitFor(() => {
      const updatedRow = screen.getByRole('group', { name: 'Total Amount' });
      expect(within(updatedRow).getByLabelText(/amount/i)).toHaveValue('6123.45');
    });
  });
});
