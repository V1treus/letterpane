import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', outputDir: '../.build/ui-test-results',
  timeout: 25000, expect: { timeout: 6000 }, workers: 1, retries: 0,
  forbidOnly: !!process.env.CI, reporter: 'list',
  use: { headless: true, viewport: { width: 1280, height: 820 },
    launchOptions: process.env.POSTA_QA_CHROME ? { executablePath: process.env.POSTA_QA_CHROME } : {},
    screenshot: 'only-on-failure', trace: 'retain-on-failure' }
});
