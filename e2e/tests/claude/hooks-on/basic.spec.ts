import path from 'path';

import { expect, test } from '../../../fixtures/pixel-agents';
import {
  idlePrompt,
  permissionRequest,
  preToolUseBash,
  sessionEndExit,
  sessionStartStartup,
} from '../../../helpers/hooks';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  spawnExternalClaudeScenario,
  waitForClaudeHookSetup,
} from '../../../helpers/mock-claude';
import { expectOverlayCount, expectOverlayVisible } from '../../../helpers/office';
import { getPixelAgentsFrame, openPixelAgentsPanel, setSettings } from '../../../helpers/webview';

test.describe('Hooks ON / Basic', () => {
  test('A1 internal basic spawn smoke', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(tmpHome, claudeScenario('A1 internal basic spawn').build());
    const spawned = await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);

    expect(spawned.invocationLog).toContain(`session-id=${spawned.sessionId}`);
    expect(path.basename(spawned.jsonlFile)).toBe(`${spawned.sessionId}.jsonl`);

    const terminalTab = window.getByText(/Claude Code #\d+/);
    await expect(terminalTab.first()).toBeVisible({ timeout: 15_000 });

    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    await expectOverlayCount(panelFrame, 1);
  });

  // A7 passes 5/5 in isolation but fails reliably in the full serial suite,
  // including under retries: 1. The final screenshot shows VS Code's
  // "All installed extensions are temporarily disabled" banner, meaning the
  // extension host got disabled mid-test. Likely accumulated state/resource
  // pressure from many sequential Electron launches in CI rather than a real
  // product bug. Track in a follow-up; the test stays in the file so the
  // coverage is documented.
  test('A7 external hook session smoke', async ({ pixelAgents }) => {
    const { frame, tmpHome, workspaceDir } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    await waitForClaudeHookSetup(tmpHome);
    const sessionId = 'a7-external-session';
    const scenario = claudeScenario('A7 external hook session smoke')
      .at(200)
      .emitHook(
        sessionStartStartup(sessionId, '{{cwd}}', '{{transcriptPath}}') as Record<string, unknown>,
      )
      .at(2_000)
      .emitHook(preToolUseBash(sessionId, 'npm test') as Record<string, unknown>)
      .at(3_200)
      .emitHook(permissionRequest(sessionId) as Record<string, unknown>)
      .at(4_400)
      .emitHook(idlePrompt(sessionId) as Record<string, unknown>)
      .at(6_000)
      .emitHook(sessionEndExit(sessionId) as Record<string, unknown>)
      .exitAt(6_200)
      .build();

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile: pixelAgents.mockLogFile,
      scenario,
      sessionId,
    });

    await frame.waitForTimeout(500);
    await expectOverlayCount(frame, 0);

    await expectOverlayCount(frame, 1);
    await expectOverlayVisible(frame, 'Running: npm test');

    await expectOverlayVisible(frame, 'Needs approval');

    await expectOverlayVisible(frame, 'Might be waiting for input');

    await expectOverlayCount(frame, 0);
  });
});
