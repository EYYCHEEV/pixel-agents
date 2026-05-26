import type { Frame, Locator } from '@playwright/test';
import { expect } from '@playwright/test';

const OVERLAY_TIMEOUT_MS = 15_000;

export function getAgentOverlays(frame: Frame): Locator {
  return frame.locator('[data-testid="agent-overlay"]');
}

export function getOverlayByText(frame: Frame, text: string): Locator {
  return getAgentOverlays(frame).filter({ hasText: text });
}

export function getOverlayByTexts(frame: Frame, texts: string[]): Locator {
  return texts.reduce<Locator>(
    (locator, text) => locator.filter({ hasText: text }),
    getAgentOverlays(frame),
  );
}

export function getOverlayByAgentId(frame: Frame, agentId: number): Locator {
  return frame.locator(`[data-testid="agent-overlay"][data-agent-id="${agentId}"]`);
}

export async function expectOverlayCount(
  frame: Frame,
  count: number,
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect(getAgentOverlays(frame)).toHaveCount(count, { timeout });
}

export async function expectOverlayVisible(
  frame: Frame,
  text: string,
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect(getOverlayByText(frame, text).first()).toBeVisible({ timeout });
}

export async function expectOverlayVisibleWithTexts(
  frame: Frame,
  texts: string[],
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect(getOverlayByTexts(frame, texts).first()).toBeVisible({ timeout });
}

export async function expectOverlayVisibleForAgent(
  frame: Frame,
  agentId: number,
  text: string,
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect(getOverlayByAgentId(frame, agentId).filter({ hasText: text })).toBeVisible({
    timeout,
  });
}

export async function expectNoOverlay(frame: Frame, text: string, timeout = 1_000): Promise<void> {
  await expect(getOverlayByText(frame, text)).toHaveCount(0, { timeout });
}

export async function expectNoOverlayWithTexts(
  frame: Frame,
  texts: string[],
  timeout = 1_000,
): Promise<void> {
  await expect(getOverlayByTexts(frame, texts)).toHaveCount(0, { timeout });
}

export async function readAgentOverlayIds(frame: Frame): Promise<number[]> {
  const rawIds = await getAgentOverlays(frame).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-agent-id')),
  );

  return rawIds.flatMap((value) => {
    const id = Number(value);
    return Number.isFinite(id) ? [id] : [];
  });
}

export async function readAgentOverlayTexts(
  frame: Frame,
): Promise<Array<{ id: number; text: string }>> {
  return getAgentOverlays(frame).evaluateAll((elements) =>
    elements.flatMap((element) => {
      const rawId = element.getAttribute('data-agent-id');
      const id = Number(rawId);
      if (!Number.isFinite(id)) {
        return [];
      }
      return [
        {
          id,
          text: element.textContent ?? '',
        },
      ];
    }),
  );
}

export async function expectSingleAgentOverlay(frame: Frame): Promise<number> {
  await expectOverlayCount(frame, 1);
  const ids = await readAgentOverlayIds(frame);
  if (ids.length !== 1) {
    throw new Error(`Expected exactly one agent overlay id, got ${JSON.stringify(ids)}`);
  }
  return ids[0]!;
}

export async function closeAgentFromOverlay(
  frame: Frame,
  options: { agentId?: number; text?: string },
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  const overlay =
    options.agentId !== undefined
      ? getOverlayByAgentId(frame, options.agentId).first()
      : getOverlayByText(frame, options.text ?? '').first();
  await expect(overlay).toBeVisible({ timeout });

  const canvas = frame.locator('canvas');
  const canvasBox = await canvas.boundingBox();
  const overlayBox = await overlay.boundingBox();
  if (!canvasBox || !overlayBox) {
    throw new Error('Missing canvas or overlay bounding box while closing agent');
  }

  const clickX = overlayBox.x - canvasBox.x + overlayBox.width / 2;
  const clickOffsets = [overlayBox.height + 16, overlayBox.height + 28, 60];

  for (const clickOffset of clickOffsets) {
    const clickY = Math.min(canvasBox.height - 4, overlayBox.y - canvasBox.y + clickOffset);
    await canvas.click({
      position: {
        x: clickX,
        y: clickY,
      },
    });

    const closeButton = overlay.locator('button[title="Close agent"]');
    try {
      await expect(closeButton).toBeVisible({ timeout: 1_500 });
      await closeButton.click();
      return;
    } catch {
      // Retry with a slightly different hit position if the first click missed the sprite.
    }
  }

  throw new Error('Failed to select agent overlay before attempting close');
}
