import { describe, expect, it } from 'vitest';

import {
  isOmpProcess,
  parseProcessList,
  parseTmuxTerminalKeys,
} from '../src/recovery/processInventory.js';

describe('recovery process inventory', () => {
  it('parses bounded ps rows without treating detached processes as terminal sessions', () => {
    expect(
      parseProcessList(`
       42 ttys016 omp --config profile.yml
       43 ?? codex
       bad ttys017 ignored
      `),
    ).toEqual([
      { pid: 42, tty: 'ttys016', command: 'omp --config profile.yml' },
      { pid: 43, command: 'codex' },
    ]);
  });

  it('recognizes OMP executables without matching unrelated command substrings', () => {
    expect(isOmpProcess({ pid: 1, command: '/opt/bin/omp --resume session' })).toBe(true);
    expect(isOmpProcess({ pid: 2, command: 'node /tmp/compile.js' })).toBe(false);
  });

  it('maps only tmux panes whose terminal owns an OMP process', () => {
    expect(
      parseTmuxTerminalKeys('%4\t/dev/ttys016\n%5\t/dev/ttys017\n', new Set(['ttys016'])),
    ).toEqual(new Set(['tmux-%4']));
  });
});
