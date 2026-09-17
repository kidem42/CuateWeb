import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { HermesMessage } from '../../packages/data-provider/src/hermes';
const path = '/c/hermes.local.fixture.session';
async function transcript(page: Page, data: HermesMessage[]) {
  await page.route('**/api/hermes', (route) =>
    route.fulfill({
      json: [
        {
          id: 'local',
          label: 'Hermes',
          scope: 'fixture',
          files: true,
          sessionPageSize: 50,
          previewMaxBytes: 1000000,
          liveStaleMs: 1200000,
          growthHoldMs: 2000,
          stopConfirmMs: 5000,
          pollIntervalMs: 1000,
          requestTimeoutMs: 10000,
          maxUploadBytes: 1000000,
          maxChatBytes: 100000,
          maxInlineImageBytes: 100000,
          imageMaxDimension: 1000,
        },
      ],
    }),
  );
  await page.route('**/api/hermes/local/request', (route) => {
    const { operation } = route.request().postDataJSON();
    const replies: Record<string, unknown> = {
      messages: { data, truncated: false },
      session: { session: { id: 'session', title: 'Native transcript fixture' } },
      sessions: {
        data: [{ id: 'session', title: 'Native transcript fixture' }],
        offset: 0,
        limit: 50,
        has_more: false,
      },
      capabilities: { features: {} },
      models: { providers: [] },
      skills: { data: [] },
    };
    return route.fulfill({
      status: operation in replies ? 200 : 400,
      json: replies[operation] ?? { error: 'fixture_read_only' },
    });
  });
}
test('native tool history stays in one collapsed journal across refreshes', async ({ page }) => {
  const data: HermesMessage[] = [{ id: 1, role: 'user', content: 'Fixture request' }];
  for (let n = 0; n < 20; n++) {
    data.push({
      id: n * 2 + 2,
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: `call_${n}`, function: { name: n % 2 ? 'patch' : 'terminal', arguments: '{}' } },
      ],
    });
    data.push({
      id: n * 2 + 3,
      role: 'tool',
      tool_call_id: `call_${n}`,
      content: JSON.stringify({ output: `DETAIL_${n}`, exit_code: 0 }),
    });
  }
  data.push({
    id: 99,
    role: 'assistant',
    content: '# Final answer\n\n| A | B |\n|---|---|\n| 1 | 2 |',
  });
  await transcript(page, data);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Final answer', exact: true })).toBeVisible();
  const group = page.getByRole('button', { name: /^Steps · 20/ });
  await expect(group).toHaveCount(1);
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('Cancelled', { exact: true })).toHaveCount(0);
  await expect(page.locator('.message-render')).toHaveCount(2);
  await expect(page.getByRole('table')).toBeVisible();
  await group.click();
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('tool-call')).toHaveCount(20);
  await page.waitForTimeout(2200);
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await page.reload();
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.message-render')).toHaveCount(2);
});
test('native service reports, compaction and embedded steers retain their roles', async ({
  page,
}) => {
  await transcript(page, [
    { id: 1, role: 'user', content: '[CONTEXT SUMMARY]: HIDDEN_METADATA' },
    { id: 2, role: 'user', content: 'Visible request' },
    {
      id: 3,
      role: 'tool',
      content:
        'OK\n[OUT-OF-BAND USER MESSAGE]<cuate-addendum>frame</cuate-addendum>Visible steer[/OUT-OF-BAND USER MESSAGE]',
    },
    { id: 4, role: 'assistant', content: 'Acknowledged' },
    {
      id: 5,
      role: 'user',
      content:
        '[ASYNC DELEGATION BATCH COMPLETE — deleg_fixture]\nDispatched: fixture\n--- ✓ TASK 1/2: First ---\nREPORT_ONE\n--- ✗ TASK 2/2: Second ---\nREPORT_TWO',
    },
    { id: 6, role: 'assistant', content: 'Final after service' },
  ]);
  await page.goto(path);
  await expect(page.getByText('Final after service', { exact: true })).toBeVisible();
  await expect(page.getByText('Visible steer', { exact: true })).toBeVisible();
  await expect(page.getByText('HIDDEN_METADATA', { exact: false })).toHaveCount(0);
  const report = page.getByRole('button', { name: 'Background activity report', exact: true });
  await expect(report).toHaveCount(1);
  await expect(report).toHaveAttribute('aria-expanded', 'false');
  await report.click();
  await page.getByRole('button', { name: '1/2: First', exact: true }).click();
  await page.getByRole('button', { name: '2/2: Second', exact: true }).click();
  await expect(page.getByText('REPORT_ONE', { exact: false })).toBeVisible();
  await expect(page.getByText('REPORT_TWO', { exact: false })).toBeVisible();
});

test('native inline paths open Markdown preview and session files allow downloads', async ({ page }) => {
  const filePath = '/root/hermes/work/markdown-example.md';
  await transcript(page, [
    { id: 1, role: 'user', content: 'Create an example' },
    { id: 2, role: 'assistant', content: `Created: \`${filePath}\`` },
  ]);
  await page.route('**/api/hermes/local/request', async (route) => {
    const { operation } = route.request().postDataJSON();
    if (operation === 'files') return route.fulfill({ json: {
      entries: [{ name: 'markdown-example.md', is_directory: false }],
    } });
    if (operation === 'download') return route.fulfill({ contentType: 'text/markdown', body: '# Original download' });
    if (operation === 'preview') return route.fulfill({ json: {
      kind: 'text', mime: 'text/plain', text: '# File preview fixture\n\n| A | B |\n|---|---|\n| 1 | 2 |',
    } });
    return route.fallback();
  });
  await page.route('**/api/hermes/local/download**', (route) => route.fulfill({
    contentType: 'text/markdown', body: '# Original download',
  }));
  await page.goto(path);
  await page.getByRole('link', { name: 'markdown-example.md', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'File preview fixture', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('table')).toBeVisible();
  expect((await page.getByRole('dialog').boundingBox())!.height).toBeGreaterThan(page.viewportSize()!.height * 0.75);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Session files', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(filePath, { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download markdown-example.md', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('markdown-example.md');
});

test('MEDIA deliveries expose a file chip and HTML uses a tall preview', async ({ page }) => {
  await transcript(page, [{ id: 1, role: 'assistant', content: 'MEDIA:/tmp/example.html\nMEDIA:/tmp/photo.jpg\nMEDIA:/tmp/book.xlsx' }]);
  await page.route('**/api/hermes/local/request', async route => {
    if (route.request().postDataJSON().operation === 'preview') return route.fulfill({ json: { kind: 'text', mime: 'text/plain', text: '<!doctype html><html><body><h1>Preview</h1></body></html>' } });
    return route.fallback();
  });
  await page.goto(path);
  await expect(page.getByRole('link', { name: 'photo.jpg', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'book.xlsx', exact: true })).toBeVisible();
  const chip = page.getByRole('link', { name: 'example.html', exact: true });
  await expect(chip.locator('svg')).toHaveCount(1);
  await chip.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('iframe').first()).toBeVisible();
  expect((await dialog.locator('iframe').first().boundingBox())!.height).toBeGreaterThan(page.viewportSize()!.height * 0.55);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(390);
  expect(box.x).toBeGreaterThanOrEqual(0);
});
test('native skill selection loads full Markdown and exposes source', async ({ page }) => {
  await transcript(page, []);
  await page.route('**/api/hermes/local/request', async route => {
    const input = route.request().postDataJSON();
    if (input.operation === 'skills') return route.fulfill({ json: input.name
      ? { name: 'computer-use', content: '---\nname: computer-use\n---\n# Complete skill\n\nFull instructions fixture' }
      : { data: [{ name: 'computer-use', description: 'Short summary' }] } });
    return route.fallback();
  });
  await page.goto('/skills/computer-use?hermes=local');
  await expect(page.getByRole('heading', { name: 'Complete skill', exact: true })).toBeVisible();
  await expect(page.getByText('Full instructions fixture', { exact: true })).toBeVisible();
});


test('external completed exchange returns Send and Hermes has no microphone', async ({ page }) => {
  const data: HermesMessage[] = [{ id: 1, role: 'assistant', content: 'Previous answer' }];
  await transcript(page, data);
  await page.goto(path);
  await expect(page.getByText('Previous answer', { exact: true })).toBeVisible();
  await expect(page.getByTestId('send-button')).toBeVisible();
  await expect(page.locator('#audio-recorder')).toHaveCount(0);
  await page.waitForTimeout(1300);
  data.push({ id: 2, role: 'user', content: 'Desktop question', timestamp: Date.now() / 1000 });
  await expect(page.getByTestId('stop-generation-button')).toBeVisible();
  data.push({ id: 3, role: 'assistant', content: 'Desktop answer', timestamp: Date.now() / 1000 });
  await expect(page.getByTestId('send-button')).toBeVisible();
  await expect(page.getByTestId('stop-generation-button')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Desktop answer', { exact: true })).toBeVisible();
  await expect(page.getByTestId('send-button')).toBeVisible();
  await expect(page.locator('#audio-recorder')).toHaveCount(0);
});
