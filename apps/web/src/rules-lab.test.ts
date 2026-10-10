// Rules Lab tests (spec §5): render smoke for the view, plus the headless
// driver's own determinism proof — the same seed must replay the same
// winner, step count, and state hash.

import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stateHash } from '@resolveops/game/engine';
import { RulesLabView } from './rules-lab';
import { createLabGame, runHeadlessGame, summarizeGroups, summarizePlayers } from './rules-lab-sim';

describe('Rules Lab view (render smoke)', () => {
  it('renders the idle lab with labelled controls and status text', () => {
    const html = renderToStaticMarkup(React.createElement(RulesLabView));
    expect(html).toContain('Rules Lab');
    expect(html).toContain('Seed');
    expect(html).toContain('Players');
    expect(html).toContain('Speed');
    expect(html).toContain('Run');
    expect(html).toContain('Not running');
  });
});

describe('Rules Lab headless simulation', () => {
  // Seed proven to complete under the fuzz harness's bot driver (botGame
  // "bot-p2-000", fuzz.test.ts) — reused here as the stable smoke fixture.
  const run = runHeadlessGame('bot-p2-000', 2);

  it('drives a seeded bot-vs-bot game to completion', () => {
    expect(run.endedBy).toBe('finished');
    expect(run.state.phase).toBe('finished');
    expect(run.state.winner).not.toBeNull();
    expect(run.steps).toBeLessThanOrEqual(5_000);
  });

  it('replays the same seed to the same winner, steps, and hash', () => {
    const replay = runHeadlessGame('bot-p2-000', 2);
    expect(replay.endedBy).toBe('finished');
    expect(replay.state.winner).toBe(run.state.winner);
    expect(replay.steps).toBe(run.steps);
    expect(stateHash(replay.state)).toBe(stateHash(run.state));
  });

  it('derives consistent summaries from the finished state', () => {
    const players = summarizePlayers(run.state);
    expect(players).toHaveLength(2);
    expect(players.filter(p => p.bankrupt)).toHaveLength(1);
    const winner = summarizePlayers(run.state).find(p => !p.bankrupt);
    expect(winner?.name).toBe(run.state.players[run.state.winner ?? 0].name);
    expect(summarizeGroups(run.state)).toHaveLength(8);
  });

  it('builds an idle game through the lab factory', () => {
    const game = createLabGame('lab-factory', 5);
    expect(game.players).toHaveLength(5);
    expect(game.phase).toBe('active');
    expect(game.players.every(p => p.cash === 12_000)).toBe(true);
  });
});
