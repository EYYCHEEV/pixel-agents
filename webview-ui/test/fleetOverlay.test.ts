import assert from 'node:assert/strict';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'vitest';

import type { FleetAgentMeta } from '../../core/src/messages.js';
import { FleetOverlayContent } from '../src/office/components/ToolOverlay.js';

const fleet: FleetAgentMeta = {
  providerId: 'codex',
  hostId: 'local',
  sessionId: 'session-1',
  agentId: 'agent-1',
  role: 'reviewer',
  projectLabel: 'pixel-agents',
  activity: 'Reviewing UI state',
  status: 'running',
};

test('fleet overlay exposes provider, role, project, activity, and lifecycle status', () => {
  const runningMarkup = renderToStaticMarkup(createElement(FleetOverlayContent, { fleet }));
  assert.match(runningMarkup, />codex</);
  assert.match(runningMarkup, />reviewer</);
  assert.match(runningMarkup, />pixel-agents</);
  assert.match(runningMarkup, />Reviewing UI state</);
  assert.match(runningMarkup, />running</);
  assert.match(runningMarkup, /pixel-pulse/);

  const disconnectedMarkup = renderToStaticMarkup(
    createElement(FleetOverlayContent, {
      fleet: { ...fleet, activity: undefined, status: 'disconnected' },
    }),
  );
  assert.match(disconnectedMarkup, />disconnected</);
  assert.match(disconnectedMarkup, /opacity-60/);
  assert.doesNotMatch(disconnectedMarkup, /pixel-pulse/);
});

test('fleet activity falls back to exact status and project falls back to character folder', () => {
  const markup = renderToStaticMarkup(
    createElement(FleetOverlayContent, {
      fleet: {
        ...fleet,
        role: undefined,
        projectLabel: undefined,
        activity: '   ',
        status: 'parked',
      },
      folderName: 'fallback-project',
    }),
  );

  assert.match(markup, />agent</);
  assert.match(markup, />fallback-project</);
  assert.match(markup, />parked</);
  assert.doesNotMatch(markup, /Status: parked/);
});

test('fleet lifecycle states have distinct pixel markers and only running pulses', () => {
  const renderStatus = (status: FleetAgentMeta['status']) =>
    renderToStaticMarkup(
      createElement(FleetOverlayContent, {
        fleet: { ...fleet, activity: 'Working', status },
      }),
    );

  const running = renderStatus('running');
  assert.match(running, /pixel-pulse/);
  assert.match(running, /--color-status-active/);

  const waiting = renderStatus('waiting');
  assert.match(waiting, />!</);
  assert.match(waiting, /--color-status-permission/);
  assert.doesNotMatch(waiting, /pixel-pulse/);

  const idle = renderStatus('idle');
  assert.match(idle, />•</);
  assert.match(idle, /--color-status-success/);

  const parked = renderStatus('parked');
  assert.match(parked, />Ⅱ</);
  assert.match(parked, /opacity-75/);

  const completed = renderStatus('completed');
  assert.match(completed, />✓</);
  assert.match(completed, /opacity-90/);

  const disconnected = renderStatus('disconnected');
  assert.match(disconnected, />×</);
  assert.match(disconnected, /--color-status-error/);
  assert.match(disconnected, /opacity-60/);
});

test('inferred fleet metadata shows a compact qualifier and recovery explanation', () => {
  const markup = renderToStaticMarkup(
    createElement(FleetOverlayContent, { fleet: { ...fleet, inferred: true } }),
  );

  assert.match(markup, />inferred</);
  assert.match(markup, /title="Lifecycle state is recovered approximately"/);
  assert.match(
    markup,
    /aria-label="Inferred telemetry: lifecycle state is recovered approximately"/,
  );
});

test('authoritative fleet metadata omits the inferred qualifier', () => {
  const markup = renderToStaticMarkup(createElement(FleetOverlayContent, { fleet }));

  assert.doesNotMatch(markup, />inferred</);
  assert.doesNotMatch(markup, /Lifecycle state is recovered approximately/);
});
