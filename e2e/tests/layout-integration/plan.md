# Layout Integration E2E Plan

## Scope

Design a reliable E2E suite for layout editing flows (tile/furniture/wall placement and erasure) without implementing tests yet.

## Goals

- Validate that user-visible layout edits persist correctly to `~/.pixel-agents/layout.json`.
- Cover highest-risk editor workflows with low flake and acceptable CI runtime.
- Reuse existing Playwright Electron harness and mock-Claude isolation patterns.

## Non-goals

- Pixel-perfect rendering validation (sprite-level visual fidelity).
- Exhaustive per-asset furniture permutations.
- Performance benchmarking/load testing.
- Full native file picker UX coverage for import/export in the main PR suite.

## Constraints and realities in this repo

- Layout saves are debounced (`LAYOUT_SAVE_DEBOUNCE_MS`) and file writes are atomic (tmp + rename), so assertions must poll.
- Editor interactions are largely canvas-based; naive coordinate clicks are brittle.
- Furniture catalog is dynamic; tests must avoid assumptions tied to unstable ordering.
- Existing E2E suite already has long runtime pressure and occasional platform variance.

---

## Strategy options

### Option A — Pure black-box canvas E2E

**What it is:** interact only through visible UI/canvas, assert visible behavior.  
**Pros:** closest to real user behavior.  
**Cons:** highest flake (DPR/coordinate drift), expensive to debug, slowest CI.

### Option B — Hybrid E2E (UI actions + persisted-state assertions)

**What it is:** drive UI like a user, but assert deterministic outcomes primarily via `layout.json` and stable toolbar/action states.  
**Pros:** strongest reliability-to-confidence ratio; easier root-cause analysis.  
**Cons:** does not fully catch purely visual regressions.

### Option C — Thin E2E + push most coverage lower-level

**What it is:** minimal user journeys in E2E, rely on unit/integration tests for edit logic.  
**Pros:** fastest runtime.  
**Cons:** weaker end-to-end confidence for real interactions.

## Recommendation

Adopt **Option B** as the main approach, plus a small amount of Option C for editor logic edge cases.

Why:

- Preserves true user journeys while keeping assertions deterministic.
- Best fit for existing infra (file-backed persistence, mock harness, long-running CI constraints).
- Reduces sensitivity to canvas rendering variance without discarding end-to-end behavior checks.

---

## Delivery phases (prioritized)

### Phase 0 — Harness hardening (precondition)

1. Add deterministic test helpers for tile/canvas targeting.
2. Seed known layout fixture per test to avoid default-layout drift.
3. Ensure blocker modals/tooltips are dismissed in setup.

### Phase 1 — Smoke (always-on)

1. Enter Layout mode, perform one floor paint, Save.
2. Verify persisted file changed as expected.
3. Undo/Redo one edit path.

### Phase 2 — Core editing flows

1. Floor paint + erase (including drag behavior).
2. Wall paint toggle + erase + wall eyedropper tool switch.
3. Furniture place, rotate (`R`), toggle state (`T`), drag-move, delete.
4. Save + Reset to last saved state.

### Phase 3 — Constraints and structure

1. Placement validity matrix (VOID, collisions, wall-only, surface placement, background tile behavior).
2. Grid expansion in four directions and coordinate shift correctness.
3. Boundary behavior near max dimensions (guardrails).

### Phase 4 — Advanced/periodic coverage

1. Import/export behavior (without overfitting to native dialog details).
2. External layout change / watcher synchronization scenarios.

---

## Planned test inventory by feature area

### Floor / tile editing

- Paint tile with selected floor pattern+color.
- Erase to VOID (tool + right-click path).
- Eyedropper picks floor pattern and color.

### Wall editing

- Paint walls with drag and toggle semantics.
- Erase walls via wall tool and right-click erasure.
- Eyedropper on wall picks wall color and switches tool context.

### Furniture editing

- Place valid furniture and reject invalid placement.
- Rotate selected furniture and validate orientation result.
- Toggle state (on/off variant) where applicable.
- Drag selected furniture to new valid location.
- Delete selected furniture.

### Editing history and persistence

- Undo/Redo stack correctness after multi-step edits.
- Save commits current layout snapshot.
- Reset restores to last saved snapshot.

### Layout structure

- Expansion from each ghost border side.
- Left/up expansion shifts coordinates for existing entities correctly.

---

## Assertion strategy

Use layered assertions in this priority:

1. **Primary:** persisted `layout.json` invariants (`tiles`, `furniture`, `tileColors`, dimensions).
2. **Secondary:** stable UI state (active tool, dirty state/action bar availability, selection state).
3. **Tertiary:** minimal visual checks only where state cannot be inferred.

Avoid:

- Screenshot-heavy correctness checks.
- Assertions bound to dynamic catalog index ordering.

---

## Flake control strategy

- Keep layout suite agent-free (no agent spawn dependency).
- Run with isolated test HOME/workspace fixtures.
- Prefer keyboard shortcuts for rotate/toggle/delete over small overlay hit targets.
- Use `expect.poll` for all persistence checks (debounce + atomic write aware).
- Keep layout suite single-worker in CI initially; parallelize only after stability data.

---

## Risks, gaps, and mitigation

1. **Residual canvas targeting fragility** despite helpers (DPR and viewport variance can still drift edge interactions).  
   **Mitigation:** constrain viewport/zoom in fixture, centralize coordinate utility, prioritize keyboard-driven interactions where possible.

2. **Hybrid assertions can miss purely visual regressions** (e.g., z-sorting artifacts with logically correct layout data).  
   **Mitigation:** add a small curated visual smoke subset for high-risk rendering cases, not full-suite screenshot gating.

3. **CI runtime pressure from advanced scenarios** (especially import/export and cross-window sync).  
   **Mitigation:** keep advanced scenarios in periodic/nightly lanes until runtime budget and flake profile are proven.

4. **Dynamic asset evolution may invalidate brittle fixture assumptions over time.**  
   **Mitigation:** anchor tests to structural outcomes and capability classes (wall-placeable/surface-placeable), not specific UI ordering.

---

## Readiness criteria before implementation

- Deterministic tile/canvas helper agreed.
- Seeded layout fixture strategy agreed.
- Smoke/core split agreed with CI owner (always-on vs periodic).
- Assertion contract agreed (`layout.json` first, UI state second).
