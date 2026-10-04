import { defineConfig } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Ephemeral test credentials/data; never borrow a live password or volume.
process.env.DASHBOARD_TEST_PASSWORD ??= randomBytes(32).toString('hex');
const dataDir = mkdtempSync(join(tmpdir(), 'dashboard-test-'));
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:3101', browserName: 'chromium' },
  webServer: {
    command: 'node server.js',
    url: 'http://127.0.0.1:3101/api/health',
    reuseExistingServer: false,
    env: {
      PORT: '3101', HOST: '127.0.0.1',
      ADMIN_PASSWORD: process.env.DASHBOARD_TEST_PASSWORD,
      DASHBOARD_DATA_DIR: dataDir,
    },
  },
});
