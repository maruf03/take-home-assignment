import path from 'node:path';
import { expect, test } from '@playwright/test';
import { expectZeroSeriousAxe, uploadPdfViaDialog } from './helpers.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURES_DOCS = path.join(REPO_ROOT, 'fixtures', 'documents');
const CRAFTED_DOCS = path.join(REPO_ROOT, 'fixtures-golden', 'crafted');

test.describe('Core E2E journeys with axe accessibility checks', () => {
  test('[R1] [I12] Journey 1: upload -> extract -> approve all values', async ({ page }) => {
    const title = `E2E Invoice J1 ${Date.now()}`;

    await page.goto('/documents?view=needs-review&pollMs=250');
    await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Needs review/i })).toBeVisible();
    await expectZeroSeriousAxe(page, 'Documents queue (Needs review)');

    const docId = await uploadPdfViaDialog(page, {
      typeLabel: 'Invoice',
      filePath: path.join(FIXTURES_DOCS, 'invoice-001.pdf'),
      title,
    });

    // Navigate with fast pollMs so Playwright observes extraction quickly without waitForTimeout
    await page.goto(`/documents/${docId}?pollMs=250`);

    // Wait until extracted values appear (Needs review group has 5 invoice fields)
    await expect(page.getByRole('group', { name: 'Total Amount' })).toBeVisible({
      timeout: 25_000,
    });
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expectZeroSeriousAxe(page, 'Document detail (extracted invoice)');

    // Approve all 5 invoice fields one by one
    const fieldLabels = ['Vendor Name', 'Invoice Number', 'Issue Date', 'Due Date', 'Total Amount'];
    for (const label of fieldLabels) {
      const row = page.getByRole('group', { name: label });
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(row).toBeHidden();
    }

    // All 5 values moved into Done; progress bar reports 5 of 5 reviewed
    await expect(page.getByRole('img', { name: '5 of 5 values reviewed' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Show done \(5\)/i })).toBeVisible();
    await expectZeroSeriousAxe(page, 'Document detail (all approved)');
  });

  test('[R7] [R8] [I12] Journey 2: upload v2 -> exactly 2 in Changed with previous & diff, 3 carried', async ({
    page,
  }) => {
    const title = `E2E Invoice V2 ${Date.now()}`;

    await page.goto('/documents?view=needs-review&pollMs=250');
    const docId = await uploadPdfViaDialog(page, {
      typeLabel: 'Invoice',
      filePath: path.join(FIXTURES_DOCS, 'invoice-001.pdf'),
      title,
    });
    await page.goto(`/documents/${docId}?pollMs=250`);
    await expect(page.getByRole('group', { name: 'Total Amount' })).toBeVisible({
      timeout: 25_000,
    });

    // Approve all 5 v1 fields
    for (const label of [
      'Vendor Name',
      'Invoice Number',
      'Issue Date',
      'Due Date',
      'Total Amount',
    ]) {
      const row = page.getByRole('group', { name: label });
      await row.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(row).toBeHidden();
    }
    await expect(page.getByRole('img', { name: '5 of 5 values reviewed' })).toBeVisible();

    // Upload invoice-001.v2.pdf as v2 via header "Upload new version" dialog
    await page.getByRole('button', { name: 'Upload new version' }).click();
    const versionDialog = page.getByRole('dialog', { name: 'Upload new version' });
    await expect(versionDialog).toBeVisible();
    await versionDialog
      .getByLabel('PDF file')
      .setInputFiles(path.join(FIXTURES_DOCS, 'invoice-001.v2.pdf'));
    await versionDialog.getByRole('button', { name: 'Upload version' }).click();
    await expect(versionDialog).toBeHidden();

    // Poll until v2 is extracted and Changed since v1 shows exactly 2 fields (Due Date & Total Amount)
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`/api/documents/${docId}`);
          const body = (await res.json()) as {
            valuesVersion: number | null;
            currentVersion: { number: number; status: string };
          };
          return `${body.currentVersion.number}:${body.currentVersion.status}:${body.valuesVersion}`;
        },
        { timeout: 25_000 },
      )
      .toBe('2:extracted:2');

    await page.goto(`/documents/${docId}?pollMs=250`);

    // Assert Changed group is first with exactly 2 items and Done has 3 carried items
    const sectionHeadings = await page.locator('section[id^="group-"] h2').allTextContents();
    expect(sectionHeadings[0]).toMatch(/Changed since v1\s*\(2\)/i);
    expect(sectionHeadings[3]).toMatch(/Done\s*\(3\)/i);

    const totalRow = page.getByRole('group', { name: 'Total Amount' });
    await expect(totalRow).toBeVisible();
    await expect(totalRow.getByText(/Previous \(v1\)/i)).toBeVisible();
    await expect(totalRow.getByText(/\$5,230\.29/).first()).toBeVisible();
    await expect(totalRow.locator('del')).toBeVisible();
    await expect(totalRow.locator('ins')).toBeVisible();

    await expect(page.getByRole('group', { name: 'Due Date' })).toBeVisible();

    // Expand Done to verify 3 carried-over rows
    await page.getByRole('button', { name: /Show done \(3\)/i }).click();
    await expect(page.getByRole('group', { name: 'Vendor Name' })).toContainText(
      /Carried from v1, approved/i,
    );
    await expectZeroSeriousAxe(page, 'Document detail (v2 Changed + Carried)');
  });

  test('[R6] [I12] Journey 3: gap row -> confirm not present and correct with canonical value', async ({
    page,
  }) => {
    const title = `E2E Market Report ${Date.now()}`;

    await page.goto('/documents?view=needs-review&pollMs=250');
    const docId = await uploadPdfViaDialog(page, {
      typeLabel: 'Market report',
      filePath: path.join(FIXTURES_DOCS, 'market-report-excerpt-001.pdf'),
      title,
    });
    await page.goto(`/documents/${docId}?pollMs=250`);

    // Median Household Income is a NOT_FOUND gap
    const gapRow = page.getByRole('group', { name: 'Median Household Income' });
    await expect(gapRow).toBeVisible({ timeout: 25_000 });
    await expect(gapRow.getByRole('button', { name: 'Confirm not present' })).toBeVisible();
    await expect(gapRow.getByRole('button', { name: 'Enter value' })).toBeVisible();
    await expectZeroSeriousAxe(page, 'Document detail (Market Report gap)');

    // 1. Confirm not present
    await gapRow.getByRole('button', { name: 'Confirm not present' }).click();
    await expect(gapRow).toBeHidden();

    // 2. Expand Done, Change decision -> Enter value -> save canonical money correction
    await page.getByRole('button', { name: /Show done \(1\)/i }).click();
    const doneGapRow = page.getByRole('group', { name: 'Median Household Income' });
    await expect(doneGapRow).toBeVisible();
    await doneGapRow.getByRole('button', { name: 'Change decision' }).click();
    await doneGapRow.getByRole('button', { name: 'Enter value' }).click();

    await doneGapRow.getByLabel('Amount').fill('$85,000');
    await expect(doneGapRow.getByTestId('canonical-preview')).toContainText(
      /Will save as:\s*\$85,000\.00/i,
    );
    await doneGapRow.getByLabel('Note (optional)').fill('Verified in county census annex');
    await expectZeroSeriousAxe(page, 'Document detail (Gap correction form)');

    await doneGapRow.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(doneGapRow.getByText('$85,000.00')).toBeVisible();
    await expect(doneGapRow.getByText(/Corrected/i)).toBeVisible();
    await expectZeroSeriousAxe(page, 'Document detail (Gap corrected)');
  });

  test('[R5] [I12] Journey 4: failed extraction -> Retry button re-enqueues run #2', async ({
    page,
  }) => {
    const title = `E2E Refusal Retry ${Date.now()}`;

    await page.goto('/documents?view=needs-review&pollMs=250');
    const docId = await uploadPdfViaDialog(page, {
      typeLabel: 'Invoice',
      filePath: path.join(CRAFTED_DOCS, 'low-visibility.pdf'),
      title,
    });
    await page.goto(`/documents/${docId}?pollMs=250`);

    // Wait for worker to fail v1 with LLM_REFUSED (retryable: true) via the e2e refusal cassette
    await expect(page.getByRole('heading', { name: 'Extraction failed' })).toBeVisible({
      timeout: 25_000,
    });
    await expect(
      page.getByText(/The AI returned an unusable answer\. Retry usually fixes this\./i),
    ).toBeVisible();
    const retryBtn = page.getByRole('button', { name: /Retry/i });
    await expect(retryBtn).toBeVisible();
    await expectZeroSeriousAxe(page, 'Document detail (Failed with Retry)');

    // Click Retry and verify 202 + run #2 executes via BullMQ worker
    const [retryResponse] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes(`/api/documents/${docId}/versions/1/retry`) &&
          res.request().method() === 'POST',
      ),
      retryBtn.click(),
    ]);
    expect(retryResponse.status()).toBe(202);

    await expect
      .poll(
        async () => {
          const runsRes = await page.request.get(`/api/documents/${docId}/versions/1/runs`);
          const runsBody = (await runsRes.json()) as {
            data: Array<{ runNumber: number; status: string }>;
          };
          return runsBody.data.some((r) => r.runNumber >= 2 && r.status === 'failed');
        },
        { timeout: 25_000 },
      )
      .toBe(true);
  });
});
