import { expect, test } from '../../../fixtures/pixel-agents';
import {
  spawnInternalAgentAndWait,
  spawnInternalAgentAndWaitForInvocation,
} from '../../../helpers/internal-agent';
import {
  INLINE_TEAMMATE_ALIAS,
  INLINE_TEAMMATE_ROLE,
  uniqueTeamName,
  withInlineTeammateSession,
} from '../../../helpers/lifecycle';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  mockClaudeInitRecord,
  spawnExternalClaudeScenario,
} from '../../../helpers/mock-claude';
import {
  closeAgentFromOverlay,
  expectNoOverlay,
  expectNoOverlayWithTexts,
  expectOverlayCount,
  expectOverlayVisible,
  expectOverlayVisibleForAgent,
  expectOverlayVisibleWithTexts,
  expectSingleAgentOverlay,
  readAgentOverlayIds,
  readAgentOverlayTexts,
} from '../../../helpers/office';
import {
  buildAssistantToolUseBatchRecord,
  buildAssistantToolUseRecord,
  buildClearCommandRecord,
  buildTeamConfig,
  buildTeamMetadataRecord,
  buildTurnDurationRecord,
  buildUserToolResultBatchRecord,
  seedTeamConfig,
} from '../../../helpers/team';
import { getPixelAgentsFrame, openPixelAgentsPanel, setSettings } from '../../../helpers/webview';

const PARALLEL_PARENT_TOOL_ID = 'toolu-b5-parent';

function otherOverlayId(ids: number[], knownId: number): number {
  const otherId = ids.find((id) => id !== knownId);
  if (otherId === undefined) {
    throw new Error(`Expected an overlay id other than ${knownId}, got ${JSON.stringify(ids)}`);
  }
  return otherId;
}

test.describe('Hooks OFF / Lifecycle', () => {
  test('B1 internal clear reassignment', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('B1 internal clear reassignment hooks off')
        .defineSession('replacement', '{{sessionId}}-clear')
        .at(3_500)
        .appendJsonl(mockClaudeInitRecord('mock-claude-clear-ready'), {
          session: 'replacement',
        })
        .at(3_550)
        .appendJsonl(buildClearCommandRecord(), {
          session: 'replacement',
        })
        .at(4_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b1-fresh', 'Bash', {
            command: 'npm test',
          }),
          { session: 'replacement' },
        )
        .at(5_100)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b1-stale', 'Bash', {
            command: 'npm run stale',
          }),
        )
        .holdOpenFor(8_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const originalAgentId = await expectSingleAgentOverlay(panelFrame);

    await expectOverlayVisible(panelFrame, 'Running: npm test', 12_000);
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);

    await panelFrame.waitForTimeout(1_000);
    await expectNoOverlay(panelFrame, 'Running: npm run stale');
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
  });

  // B3 internal resume reassignment within grace: deleted.
  //
  // The test exercised the heuristic resume-reassignment path (no SessionStart
  // hook to drive it). That path was intentionally dropped in v1.1: the per-agent
  // /clear detection now requires the literal "/clear</command-name>" substring
  // in the new JSONL (see fileWatcher.ts: "Dropped 'last-prompt' check because
  // it also appears in --resume sessions"). The hooks-ON counterpart in
  // hooks-on/lifecycle.spec.ts covers resume via SessionEndResume +
  // SessionStartResume hooks, which is the supported path.

  test('B2 clear edge with another agent in the same projectDir', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('B2 sibling internal agent hooks off')
        .at(2_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b2-sibling', 'Bash', {
            command: 'npm run sibling',
          }),
        )
        .holdOpenFor(12_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    let panelFrame = await getPixelAgentsFrame(window);
    const siblingAgentId = await expectSingleAgentOverlay(panelFrame);

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('B2 internal clear with sibling present hooks off')
        .defineSession('replacement', '{{sessionId}}-clear')
        .at(3_500)
        .appendJsonl(mockClaudeInitRecord('mock-claude-b2-clear-ready'), {
          session: 'replacement',
        })
        .at(3_550)
        .appendJsonl(buildClearCommandRecord(), {
          session: 'replacement',
        })
        .at(4_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b2-fresh', 'Bash', {
            command: 'npm run cleared',
          }),
          { session: 'replacement' },
        )
        .at(5_100)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b2-stale', 'Bash', {
            command: 'npm run stale',
          }),
        )
        .holdOpenFor(8_000)
        .build(),
    );

    await spawnInternalAgentAndWait(panelFrame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    panelFrame = await getPixelAgentsFrame(window);
    await expectOverlayCount(panelFrame, 2, 12_000);
    const clearingAgentId = otherOverlayId(await readAgentOverlayIds(panelFrame), siblingAgentId);

    await expectOverlayVisibleForAgent(panelFrame, clearingAgentId, 'Running: npm run cleared');
    await expectNoOverlay(panelFrame, 'Running: npm run stale');
    const overlayTexts = await readAgentOverlayTexts(panelFrame);
    const siblingOverlay = overlayTexts.find(({ id }) => id === siblingAgentId);
    expect(siblingOverlay).toBeDefined();
    expect(siblingOverlay?.text).not.toContain('npm run cleared');
    expect(siblingOverlay?.text).not.toContain('npm run stale');
    expect([...(await readAgentOverlayIds(panelFrame)).sort((a, b) => a - b)]).toEqual([
      siblingAgentId,
      clearingAgentId,
    ]);
  });

  test('B4 heuristic late resume after stale cleanup prevents zombies', async ({ pixelAgents }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId: 'b4-hooks-off-old',
      scenario: claudeScenario('B4 late resume after stale cleanup hooks off old')
        .at(5_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b4-before', 'Bash', {
            command: 'npm run before-resume',
          }),
        )
        .at(6_500)
        .deletePath('{{transcriptPath}}')
        .holdOpenFor(10_000)
        .build(),
    });

    await expectOverlayVisible(frame, 'Running: npm run before-resume');
    const oldAgentId = await expectSingleAgentOverlay(frame);

    await expectOverlayCount(frame, 0, 45_000);

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId: 'b4-hooks-off-resumed',
      scenario: claudeScenario('B4 late resume after stale cleanup hooks off new')
        .at(5_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b4-late', 'Bash', {
            command: 'npm run late-resume',
          }),
        )
        .holdOpenFor(12_000)
        .build(),
    });

    await expectOverlayVisible(frame, 'Running: npm run late-resume', 12_000);
    const [newAgentId] = await readAgentOverlayIds(frame);
    expect(newAgentId).toBeDefined();
    expect(newAgentId).not.toBe(oldAgentId);
  });

  test('B5 three parallel Task subagents in one turn', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('B5 three parallel Task subagents in one turn hooks off')
        .at(2_500)
        .appendJsonl(
          buildAssistantToolUseBatchRecord([
            {
              toolId: `${PARALLEL_PARENT_TOOL_ID}-1`,
              toolName: 'Task',
              input: { description: 'Parallel task 1' },
            },
            {
              toolId: `${PARALLEL_PARENT_TOOL_ID}-2`,
              toolName: 'Task',
              input: { description: 'Parallel task 2' },
            },
            {
              toolId: `${PARALLEL_PARENT_TOOL_ID}-3`,
              toolName: 'Task',
              input: { description: 'Parallel task 3' },
            },
          ]),
        )
        .at(9_000)
        .appendJsonl(
          buildUserToolResultBatchRecord([
            { toolUseId: `${PARALLEL_PARENT_TOOL_ID}-1` },
            { toolUseId: `${PARALLEL_PARENT_TOOL_ID}-2` },
            { toolUseId: `${PARALLEL_PARENT_TOOL_ID}-3` },
          ]),
        )
        .at(10_200)
        .appendJsonl(buildTurnDurationRecord())
        .holdOpenFor(13_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    await expectOverlayVisible(panelFrame, 'Subtask: Parallel task 3');
    await expectOverlayVisible(panelFrame, 'Parallel task 1');
    await expectOverlayVisible(panelFrame, 'Parallel task 2');
    await expectOverlayVisible(panelFrame, 'Parallel task 3');
    await expectOverlayCount(panelFrame, 4, 10_000);
    expect(await readAgentOverlayIds(panelFrame)).toHaveLength(4);

    await expectOverlayCount(panelFrame, 1, 16_000);
  });

  test('B6 inline teammate removed from config', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;
    const teamName = uniqueTeamName('b6-inline-hooks-off');
    const configPath = seedTeamConfig(tmpHome, teamName, ['lead', INLINE_TEAMMATE_ROLE]);

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      withInlineTeammateSession(claudeScenario('B6 inline teammate removed from config hooks off'))
        .at(500)
        .appendJsonl(buildTeamMetadataRecord(teamName))
        .at(1_500)
        .appendJsonl(buildTeamMetadataRecord(teamName, INLINE_TEAMMATE_ROLE), {
          session: INLINE_TEAMMATE_ALIAS,
        })
        .at(2_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b6-teammate-search', 'WebSearch', {
            query: 'pixel agents lifecycle regressions',
          }),
          { session: INLINE_TEAMMATE_ALIAS },
        )
        .at(8_000)
        .writeJson(configPath, buildTeamConfig(['lead']))
        .holdOpenFor(14_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    await expectOverlayVisibleWithTexts(panelFrame, [INLINE_TEAMMATE_ROLE], 10_000);
    await expectOverlayVisible(panelFrame, 'Searching the web');
    await expectOverlayCount(panelFrame, 2, 10_000);

    await expectOverlayCount(panelFrame, 1, 12_000);
    await expectNoOverlayWithTexts(panelFrame, [INLINE_TEAMMATE_ROLE], 2_000);

    await panelFrame.waitForTimeout(8_000);
    await expectOverlayCount(panelFrame, 1);
    await expectNoOverlayWithTexts(panelFrame, [INLINE_TEAMMATE_ROLE], 2_000);
  });

  test('B11 rapid clear then new tool in under 500 ms', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('B11 rapid clear then new tool in under 500 ms hooks off')
        .defineSession('replacement', '{{sessionId}}-clear-fast')
        .at(3_000)
        .appendJsonl(mockClaudeInitRecord('mock-claude-clear-fast-ready'), {
          session: 'replacement',
        })
        .at(3_050)
        .appendJsonl(buildClearCommandRecord(), {
          session: 'replacement',
        })
        .at(3_200)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b11-fresh', 'Bash', {
            command: 'npm run fresh',
          }),
          { session: 'replacement' },
        )
        .at(3_350)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b11-ghost', 'Bash', {
            command: 'npm run ghost',
          }),
        )
        .holdOpenFor(7_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const originalAgentId = await expectSingleAgentOverlay(panelFrame);

    await expectOverlayVisible(panelFrame, 'Running: npm run fresh', 12_000);
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);

    await panelFrame.waitForTimeout(1_000);
    await expectNoOverlay(panelFrame, 'Running: npm run ghost');
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
  });

  test('B12 close via X prevents old JSONL re-adoption during cooldown', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId: 'b12-hooks-off-old',
      scenario: claudeScenario('B12 dismissal cooldown hooks off old session')
        .at(5_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b12-old-live', 'Bash', {
            command: 'npm run old-live',
          }),
        )
        .at(12_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b12-old-stale', 'Bash', {
            command: 'npm run old-stale',
          }),
        )
        .holdOpenFor(16_000)
        .build(),
    });

    await expectOverlayVisible(frame, 'Running: npm run old-live');
    const oldAgentId = await expectSingleAgentOverlay(frame);
    await closeAgentFromOverlay(frame, { agentId: oldAgentId });
    await expectOverlayCount(frame, 0, 8_000);

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId: 'b12-hooks-off-new',
      scenario: claudeScenario('B12 dismissal cooldown hooks off new session')
        .at(5_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b12-new-live', 'Bash', {
            command: 'npm run reopened',
          }),
        )
        .holdOpenFor(12_000)
        .build(),
    });

    await expectOverlayVisible(frame, 'Running: npm run reopened', 12_000);
    await expectOverlayCount(frame, 1);
    const [newAgentId] = await readAgentOverlayIds(frame);
    expect(newAgentId).toBeDefined();
    expect(newAgentId).not.toBe(oldAgentId);

    await frame.waitForTimeout(8_000);
    await expectNoOverlay(frame, 'Running: npm run old-stale', 2_000);
    await expectOverlayCount(frame, 1);
  });
});
