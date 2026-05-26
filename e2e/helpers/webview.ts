import type { Frame, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

const WEBVIEW_TIMEOUT_MS = 30_000;
const PANEL_OPEN_TIMEOUT_MS = 15_000;
const MIN_PANEL_HEIGHT_PX = 320;

export interface WebviewSettings {
  watchAllSessions?: boolean;
  hooksEnabled?: boolean;
  alwaysShowLabels?: boolean;
  debugView?: boolean;
}

async function runCommand(window: Page, command: string): Promise<void> {
  // Retry the full command palette interaction up to 3 times.
  // macOS CI can swallow keypresses or fail to populate results.
  for (let attempt = 0; attempt < 3; attempt++) {
    // Dismiss any previous quick-input state
    await window.keyboard.press('Escape');
    await window.waitForTimeout(300);

    try {
      await window.keyboard.press('F1');
      await window.waitForSelector('.quick-input-widget .quick-input-filter input', {
        state: 'visible',
        timeout: 5_000,
      });
      await window.keyboard.type(command);
      // Wait for a list row matching the typed command (not stale results)
      await window.waitForSelector(`.quick-input-list .monaco-list-row[aria-label*="${command}"]`, {
        timeout: 5_000,
      });
      break;
    } catch {
      if (attempt === 2) {
        throw new Error(`Command palette failed after 3 attempts for "${command}"`);
      }
    }
  }
  await window.keyboard.press('Enter');
  await window
    .waitForSelector('.quick-input-widget', {
      state: 'hidden',
      timeout: PANEL_OPEN_TIMEOUT_MS,
    })
    .catch(() => {
      // Some commands update layout without immediately dismissing quick input.
    });
}

async function getPanelHeight(window: Page): Promise<number> {
  return window.evaluate(() => {
    const panel =
      document.querySelector<HTMLElement>('[id="workbench.panel.bottom"]') ??
      document.querySelector<HTMLElement>('.part.panel');

    return Math.round(panel?.getBoundingClientRect().height ?? 0);
  });
}

async function ensurePanelIsLarge(window: Page): Promise<void> {
  if ((await getPanelHeight(window)) > MIN_PANEL_HEIGHT_PX) {
    return;
  }

  await runCommand(window, 'View: Toggle Maximized Panel');

  await expect
    .poll(() => getPanelHeight(window), {
      message: 'Expected the bottom panel to be resized for the Pixel Agents webview',
      timeout: PANEL_OPEN_TIMEOUT_MS,
      intervals: [250, 500, 1000],
    })
    .toBeGreaterThan(MIN_PANEL_HEIGHT_PX);
}

/**
 * Open the Pixel Agents panel via the Command Palette and wait for the
 * "Pixel Agents: Show Panel" command to execute.
 */
export async function openPixelAgentsPanel(window: Page): Promise<void> {
  await runCommand(window, 'Pixel Agents: Show Panel');

  // Wait for the panel container to appear
  await window
    .waitForSelector('[id="workbench.panel.bottom"], .part.panel', {
      timeout: PANEL_OPEN_TIMEOUT_MS,
    })
    .catch(() => {
      // Panel might not use this id; just continue
    });

  await ensurePanelIsLarge(window);
}

/**
 * Find and return the Pixel Agents webview frame.
 *
 * VS Code renders WebviewViewProvider content in an <iframe> whose URL
 * starts with "vscode-webview://". Because VS Code can have multiple
 * webviews, we wait until one frame exposes the "+ Agent" button before
 * returning it.
 */
export async function getPixelAgentsFrame(window: Page): Promise<Frame> {
  const deadline = Date.now() + WEBVIEW_TIMEOUT_MS;

  while (Date.now() < deadline) {
    for (const frame of window.frames()) {
      const url = frame.url();
      if (!url.startsWith('vscode-webview://')) continue;

      try {
        const btn = await frame.waitForSelector('button:has-text("+ Agent")', { timeout: 2_000 });
        if (btn) return frame;
      } catch {
        // not this frame, keep looking
      }
    }

    // Wait for a new frame to be attached
    await window.waitForTimeout(500);
  }

  throw new Error('Timed out waiting for Pixel Agents webview frame with "+ Agent" button');
}

/**
 * Click "+ Agent" in the webview and wait for the call to be dispatched.
 */
export async function clickAddAgent(frame: Frame): Promise<void> {
  const btn = frame.locator('button', { hasText: '+ Agent' });
  await expect(btn).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  await btn.click();
}

async function setCheckbox(modal: Locator, label: string, checked: boolean): Promise<void> {
  const button = modal.locator('button', { hasText: label });
  await expect(button).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });

  const indicator = button.locator('span').last();
  const isChecked = ((await indicator.textContent()) ?? '').trim().toLowerCase() === 'x';
  if (isChecked !== checked) {
    await button.click();
  }
}

async function openSettingsModal(frame: Frame): Promise<Locator> {
  const settingsButton = frame.locator('button', { hasText: 'Settings' });
  await expect(settingsButton).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  await settingsButton.click();

  const settingsModal = frame
    .locator('div.fixed')
    .filter({ has: frame.getByText('Settings', { exact: true }) });
  await expect(settingsModal).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  return settingsModal;
}

async function closeSettingsModal(settingsModal: Locator): Promise<void> {
  const closeButton = settingsModal.getByRole('button', { name: 'x', exact: true });
  await expect(closeButton).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  await closeButton.click();
  await expect(settingsModal).toBeHidden({ timeout: WEBVIEW_TIMEOUT_MS });
}

export async function setSettings(frame: Frame, settings: WebviewSettings): Promise<void> {
  const settingsModal = await openSettingsModal(frame);

  if (settings.watchAllSessions !== undefined) {
    await setCheckbox(settingsModal, 'Watch All Sessions', settings.watchAllSessions);
  }
  if (settings.hooksEnabled !== undefined) {
    await setCheckbox(settingsModal, 'Instant Detection (Hooks)', settings.hooksEnabled);
  }
  if (settings.alwaysShowLabels !== undefined) {
    await setCheckbox(settingsModal, 'Always Show Labels', settings.alwaysShowLabels);
  }
  if (settings.debugView !== undefined) {
    await setCheckbox(settingsModal, 'Debug View', settings.debugView);
  }

  await closeSettingsModal(settingsModal);

  // Allow the extension host to process settings updates before the test continues.
  await frame.waitForTimeout(500);
}

/**
 * Enable the settings needed for the hook-server e2e assertions:
 * - Watch All Sessions, so hooks-only external sessions are adopted
 * - Always Show Labels, so the normal office view exposes stable overlay text
 */
export async function configureHookServerTestSettings(frame: Frame): Promise<void> {
  await setSettings(frame, {
    watchAllSessions: true,
    hooksEnabled: true,
    alwaysShowLabels: true,
    debugView: false,
  });
}
