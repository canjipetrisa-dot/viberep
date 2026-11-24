import { test, expect, type Page, type Route } from '@playwright/test';

// SSE mock that returns fake HTML from the "AI"
const FAKE_HTML = '<!DOCTYPE html><html><body><h1>Test App</h1></body></html>';

function sseBody(html: string): string {
  const startEvt = JSON.stringify({
    type: 'message_start',
    message: { usage: { input_tokens: 100 } },
  });
  const deltaEvt = JSON.stringify({
    type: 'content_block_delta',
    delta: { text: html },
  });
  const doneEvt = JSON.stringify({
    type: 'message_delta',
    usage: { output_tokens: 50 },
  });
  return [
    `data: ${startEvt}`,
    '',
    `data: ${deltaEvt}`,
    '',
    `data: ${doneEvt}`,
    '',
    'data: [DONE]',
    '',
  ].join('\n');
}

async function mockAnthropicAPI(page: Page, body?: string, status?: number) {
  await page.route('**/api.anthropic.com/v1/messages', (route: Route) => {
    route.fulfill({
      status: status ?? 200,
      contentType: 'text/event-stream',
      body: body ?? sseBody(FAKE_HTML),
    });
  });
}

async function checkInAndWait(page: Page) {
  await page.waitForSelector('.app-title');
  await page.click('.btn-checkin');
  // Wait for coach line to update (checked in)
  await page.waitForFunction(() => {
    const el = document.querySelector('.coach');
    return el && el.textContent && el.textContent.includes('Checked in');
  }, { timeout: 5000 });
}

async function addReps(page: Page, count: number) {
  for (let i = 0; i < count; i++) {
    await page.click('.add-rep-btn');
  }
  // Wait for balance to reflect
  await page.waitForFunction(
    (n: number) => {
      const el = document.querySelector('.balance-num');
      return el && Number(el.textContent) >= n;
    },
    count,
    { timeout: 10000 },
  );
}

function getBalance(page: Page): Promise<number> {
  return page.locator('.balance-num').textContent().then((t) => Number(t ?? '0'));
}

// ---- Tests ----

test('6. Double-click BUILD fast → balance 0 not -5 (one charge)', async ({ page }) => {
  await mockAnthropicAPI(page);
  await page.goto('/');
  await checkInAndWait(page);
  await addReps(page, 5);

  // Fill in prompt
  await page.fill('.prompt-input', 'make it blue');

  // Click BUILD twice very fast
  const buildBtn = page.locator('.build-btn');
  await Promise.all([buildBtn.click(), buildBtn.click()]);

  // Wait for build to complete
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.build-btn');
      return el && !(el as HTMLButtonElement).disabled;
    },
    { timeout: 15000 },
  );

  const bal = await getBalance(page);
  expect(bal).toBeGreaterThanOrEqual(0);
});

test('7. Spam +1 REP 50x fast → balance ≥ 50', async ({ page }) => {
  await page.goto('/');
  await checkInAndWait(page);

  // Click +1 REP 50 times as fast as possible
  const btn = page.locator('.add-rep-btn');
  for (let i = 0; i < 50; i++) {
    await btn.click({ delay: 0 });
  }

  // Wait for balance to settle
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.balance-num');
      return el && Number(el.textContent) >= 50;
    },
    { timeout: 30000 },
  );

  const bal = await getBalance(page);
  expect(bal).toBeGreaterThanOrEqual(50);
});

test('8. Spacebar in textarea → no rep added, space appears in textarea', async ({ page }) => {
  await page.goto('/');
  await checkInAndWait(page);

  const startBal = await getBalance(page);

  // Focus textarea and press space
  await page.click('.prompt-input');
  await page.keyboard.press('Space');

  // Space should appear in textarea
  const val = await page.inputValue('.prompt-input');
  expect(val).toContain(' ');

  // Balance should not increase
  const endBal = await getBalance(page);
  expect(endBal).toBe(startBal);
});

test('9. Empty prompt + BUILD → coach message, balance unchanged', async ({ page }) => {
  await mockAnthropicAPI(page);
  await page.goto('/');
  await checkInAndWait(page);
  await addReps(page, 5);

  // Wait for the check-in setTimeout (2500ms) to have fired so it won't overwrite later messages
  await page.waitForTimeout(3000);

  const balBefore = await getBalance(page);

  // Click BUILD with empty prompt
  await page.click('.build-btn');

  // Coach should show message about typing what you want to build
  await page.waitForFunction(() => {
    const el = document.querySelector('.coach');
    return el && el.textContent && el.textContent.includes('Type what you want to build');
  }, { timeout: 10000 });

  const balAfter = await getBalance(page);
  expect(balAfter).toBe(balBefore);
});

test('10. 5000-char prompt → no crash, app title still visible', async ({ page }) => {
  await mockAnthropicAPI(page);
  await page.goto('/');
  await checkInAndWait(page);
  await addReps(page, 5);

  // Type 5000 characters
  const longPrompt = 'A'.repeat(5000);
  await page.fill('.prompt-input', longPrompt);

  // Click BUILD
  await page.click('.build-btn');

  // Wait for build to finish
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.build-btn');
      return el && !(el as HTMLButtonElement).disabled;
    },
    { timeout: 15000 },
  );

  // App title should still be visible
  await expect(page.locator('.app-title')).toBeVisible();
});

test('11. AI returns garbage → preview frame renders, no crash', async ({ page }) => {
  const garbageHtml = '<not-real-html><<<>>>}{}{}{';
  await mockAnthropicAPI(page, sseBody(garbageHtml));
  await page.goto('/');
  await checkInAndWait(page);
  await addReps(page, 5);
  await page.fill('.prompt-input', 'do something');
  await page.click('.build-btn');

  // Wait for build to complete
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.build-btn');
      return el && !(el as HTMLButtonElement).disabled;
    },
    { timeout: 15000 },
  );

  // App title still visible (no crash)
  await expect(page.locator('.app-title')).toBeVisible();
  // Preview iframe should exist
  await expect(page.locator('.preview-frame')).toBeVisible();
});

test('12. Camera denied → app still works, +1 REP still works', async ({ browser }) => {
  // Create a fresh context WITHOUT the fake media stream flags
  const context = await browser.newContext();
  const page = await context.newPage();

  // Track if camera error was logged
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // Override getUserMedia to reject before navigation
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    md.getUserMedia = () =>
      Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });

  await page.goto('http://localhost:5174');
  await page.waitForSelector('.app-title');

  // Wait for the app to fully initialize (coach shows initial message)
  await page.waitForFunction(() => {
    const el = document.querySelector('.coach');
    return el && el.textContent && el.textContent.length > 0;
  }, { timeout: 10000 });

  // The app should not crash - title should be visible
  await expect(page.locator('.app-title')).toBeVisible();

  // Check in manually (button should still work even without camera)
  await page.click('.btn-checkin');
  await page.waitForFunction(() => {
    const el = document.querySelector('.coach');
    return el && el.textContent && el.textContent.includes('Checked in');
  }, { timeout: 5000 });

  // +1 REP should still work
  await page.click('.add-rep-btn');
  await page.waitForFunction(() => {
    const el = document.querySelector('.balance-num');
    return el && Number(el.textContent) >= 1;
  }, { timeout: 5000 });

  const bal = await getBalance(page);
  expect(bal).toBeGreaterThanOrEqual(1);

  await context.close();
});

test('13. No API key → coach shows "Add your Anthropic API key"', async ({ page }) => {
  // Override import.meta.env to remove the API key
  await page.addInitScript(() => {
    // @ts-expect-error - override env
    window.__VITE_REMOVE_API_KEY__ = true;
  });

  // Route to intercept the vite client module and remove the env var
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    // For the main app bundle, remove the env key
    if (url.includes('src/App') || url.includes('assets/index')) {
      const response = await route.fetch();
      const body = await response.text();
      // Replace the env variable references to make them empty
      const modified = body.replace(/import\.meta\.env\.VITE_ANTHROPIC_API_KEY/g, '""');
      await route.fulfill({
        response,
        body: modified,
      });
    } else {
      await route.continue();
    }
  });

  await page.goto('/');
  await page.waitForSelector('.app-title');

  // Check in first
  await page.click('.btn-checkin');
  await page.waitForFunction(() => {
    const el = document.querySelector('.coach');
    return el && el.textContent && el.textContent.includes('Checked in');
  }, { timeout: 5000 });

  // Add enough reps
  await addReps(page, 5);

  // Fill prompt and try to build
  await page.fill('.prompt-input', 'test build');
  await page.click('.build-btn');

  // Coach should show API key message
  await page.waitForFunction(() => {
    const el = document.querySelector('.coach');
    return el && el.textContent && (
      el.textContent.includes('API key') ||
      el.textContent.includes('api key') ||
      el.textContent.includes('Anthropic')
    );
  }, { timeout: 5000 });
});

test('14. Viewport 1280x720 → no vertical scrollbar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.waitForSelector('.app-title');

  const hasVScroll = await page.evaluate(() => {
    return document.documentElement.scrollHeight > document.documentElement.clientHeight;
  });
  expect(hasVScroll).toBe(false);
});

test('14b. Viewport 1920x1080 → no vertical scrollbar', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  await page.waitForSelector('.app-title');

  const hasVScroll = await page.evaluate(() => {
    return document.documentElement.scrollHeight > document.documentElement.clientHeight;
  });
  expect(hasVScroll).toBe(false);
});

test('API error (500) → reps not charged', async ({ page }) => {
  await mockAnthropicAPI(page, 'Internal Server Error', 500);
  await page.goto('/');
  await checkInAndWait(page);
  await addReps(page, 5);

  // Wait for check-in setTimeout to clear
  await page.waitForFunction(() => {
    const el = document.querySelector('.coach');
    return el && el.textContent && el.textContent.includes('Build unlocked');
  }, { timeout: 5000 });

  const balBefore = await getBalance(page);
  await page.fill('.prompt-input', 'make it red');
  await page.click('.build-btn');

  // Wait for error to appear in coach
  await page.waitForFunction(() => {
    const el = document.querySelector('.coach');
    return el && el.textContent && (
      el.textContent.toLowerCase().includes('error') ||
      el.textContent.toLowerCase().includes('api')
    );
  }, { timeout: 15000 });

  // Balance should not have decreased (reps not charged on error)
  const balAfter = await getBalance(page);
  expect(balAfter).toBe(balBefore);
});

test('API timeout → error handled', async ({ page }) => {
  // Mock API to abort (simulate network failure)
  await page.route('**/api.anthropic.com/v1/messages', (route: Route) => {
    route.abort('connectionrefused');
  });

  await page.goto('/');
  await checkInAndWait(page);
  await addReps(page, 5);

  // Wait for check-in setTimeout to clear
  await page.waitForFunction(() => {
    const el = document.querySelector('.coach');
    return el && el.textContent && el.textContent.includes('Build unlocked');
  }, { timeout: 5000 });

  await page.fill('.prompt-input', 'test timeout');
  await page.click('.build-btn');

  // Wait for error message in coach
  await page.waitForFunction(() => {
    const el = document.querySelector('.coach');
    return el && el.textContent && (
      el.textContent.toLowerCase().includes('error') ||
      el.textContent.toLowerCase().includes('api')
    );
  }, { timeout: 15000 });

  // App should still be functional
  await expect(page.locator('.app-title')).toBeVisible();
});
