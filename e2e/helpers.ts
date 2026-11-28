import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Runs @axe-core/playwright on the current page state and fails on any serious or critical violation
 * (spec §11.6, §14.5, [I12]).
 */
export async function expectZeroSeriousAxe(page: Page, contextLabel: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    serious,
    `axe-core found serious/critical violations on ${contextLabel}: ${JSON.stringify(
      serious.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length })),
      null,
      2,
    )}`,
  ).toEqual([]);
}

/**
 * Uploads a PDF through the UI Upload PDF dialog using role and label locators only.
 */
export async function uploadPdfViaDialog(
  page: Page,
  options: {
    readonly typeLabel: string;
    readonly filePath: string;
    readonly title: string;
  },
): Promise<string> {
  await page.getByRole('button', { name: 'Upload PDF' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Upload PDF' });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Document type').selectOption({ label: options.typeLabel });
  await dialog.getByLabel('PDF file').setInputFiles(options.filePath);
  await dialog.getByLabel('Title (optional)').fill(options.title);

  await expectZeroSeriousAxe(page, `Upload dialog (${options.title})`);

  const [uploadResponse] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/documents') && res.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: 'Upload', exact: true }).click(),
  ]);
  expect(uploadResponse.status()).toBe(201);
  const created = (await uploadResponse.json()) as { id: string };
  await expect(page).toHaveURL(new RegExp(`/documents/${created.id}`), { timeout: 10_000 });
  return created.id;
}
