// Tycoon City — Rules Lab view (spec §5).
//
// A fifth shell view: a seeded bot-vs-bot simulation driven through the
// engine with a timed loop. Proof-of-determinism surface, not a playable
// board — board rendering and tokens are Phase 2 (docs/ROADMAP.md). Same
// component idioms and tokens as the rest of the shell; no new dependencies.

import React from 'react';
import { Coins, FlaskConical, Gauge, ListOrdered, Pause, Play, ScrollText, Users } from 'lucide-react';
import { stateHash } from '@resolveops/game/engine';
import type { GameState, PlayerId } from '@resolveops/game/types';
import {
  createLabGame,
  describeEvent,
  formatTd,
  MAX_GAME_STEPS,
  specialDeedCounts,
  stepBotGame,
  summarizeGroups,
  summarizePlayers,
  TURN_STATE_LABELS,
} from './rules-lab-sim';

/** Per-seat accent dots — hues already in the shell's palette. */
const SEAT_COLORS: Record<PlayerId, string> = {
  0: '#1dafa2',
  1: '#6eddd0',
  2: '#0d1b2c',
  3: '#c55030',
  4: '#288fa1',
};

type SpeedKey = 'slow' | 'normal' | 'fast';

/** Loop pacing — a tick applies `actionsPerTick` deterministic bot steps. */
const SPEEDS: Record<SpeedKey, { label: string; everyMs: number; actionsPerTick: number }> = {
  slow: { label: 'Slow', everyMs: 150, actionsPerTick: 1 },
  normal: { label: 'Normal', everyMs: 120, actionsPerTick: 8 },
  fast: { label: 'Fast', everyMs: 60, actionsPerTick: 40 },
};

/** How many tail events the log renders (the engine log is append-only). */
const LOG_TAIL = 150;
/** Finished runs kept for the in-app determinism comparison. */
const RUN_HISTORY_MAX = 6;

interface RunRecord {
  readonly seed: string;
  readonly playerCount: number;
  readonly winnerName: string;
  readonly hash: string;
  readonly steps: number;
}

type LabStatus = 'idle' | 'running' | 'paused' | 'finished' | 'stalled';

interface LabState {
  readonly game: GameState | null;
  readonly status: LabStatus;
  readonly steps: number;
  readonly notice: string | null;
  readonly history: readonly RunRecord[];
}

const IDLE_LAB: LabState = { game: null, status: 'idle', steps: 0, notice: null, history: [] };

type LabAction =
  | { type: 'start'; seed: string; playerCount: number }
  | { type: 'tick'; maxSteps: number }
  | { type: 'pause' }
  | { type: 'resume' };

function finishRecord(game: GameState, steps: number): RunRecord {
  const winner = game.winner;
  return {
    seed: game.seed,
    playerCount: game.players.length,
    winnerName: winner !== null ? game.players[winner].name : 'nobody',
    hash: stateHash(game),
    steps,
  };
}

/** Pure reducer over the lab's run state — the only place the sim advances. */
function labReducer(state: LabState, action: LabAction): LabState {
  switch (action.type) {
    case 'start':
      return {
        game: createLabGame(action.seed, action.playerCount),
        status: 'running',
        steps: 0,
        notice: null,
        history: state.history,
      };
    case 'tick': {
      if (state.game === null || state.status !== 'running') return state;
      let game = state.game;
      let steps = state.steps;
      let status: LabStatus = state.status;
      let notice: string | null = null;
      for (let i = 0; i < action.maxSteps; i++) {
        if (game.phase === 'finished' || status === 'stalled') break;
        if (steps >= MAX_GAME_STEPS) {
          status = 'stalled';
          notice = `hit the ${MAX_GAME_STEPS}-action guard without a winner`;
          break;
        }
        const step = stepBotGame(game);
        if (step.kind === 'stepped') {
          game = step.state;
          steps++;
        } else if (step.kind === 'finished') {
          game = step.state;
          break;
        } else {
          status = 'stalled';
          notice = step.reason;
        }
      }
      if (status !== 'stalled' && game.phase === 'finished') {
        if (game.winner === null) {
          return { ...state, game, status: 'stalled', steps, notice: 'game finished without a winner — engine invariant violated' };
        }
        return { game, status: 'finished', steps, notice: null, history: [finishRecord(game, steps), ...state.history].slice(0, RUN_HISTORY_MAX) };
      }
      return { ...state, game, status, steps, notice };
    }
    case 'pause':
      return state.status === 'running' ? { ...state, status: 'paused' } : state;
    case 'resume':
      return state.status === 'paused' ? { ...state, status: 'running' } : state;
  }
}

function statusLine(lab: LabState): string {
  const game = lab.game;
  switch (lab.status) {
    case 'idle':
      return 'Not running — choose a seed and press Run.';
    case 'running':
      return game === null
        ? 'Starting…'
        : `Running — ${lab.steps} actions applied · ${game.players[game.turn.activePlayer].name}: ${TURN_STATE_LABELS[game.turn.state]}`;
    case 'paused':
      return `Paused at ${lab.steps} actions — resume or start a new run.`;
    case 'finished':
      return game === null
        ? 'Finished.'
        : `Finished in ${lab.steps} actions — ${game.players[game.winner ?? 0].name} wins · state hash ${stateHash(game)}`;
    case 'stalled':
      return `Stopped: ${lab.notice ?? 'unknown stall'}`;
  }
}

const STATUS_DOT: Record<LabStatus, string> = {
  idle: '',
  running: 'live',
  paused: '',
  finished: 'done',
  stalled: 'alert',
};

function LabPlayerMetric({ summary }: { summary: ReturnType<typeof summarizePlayers>[number] }) {
  const detail = summary.bankrupt
    ? 'Bankrupt — out of the game'
    : `Net worth ${formatTd(summary.worth)} · ${summary.tileName}${summary.atDepot ? ' · at The Depot' : ''}`;
  return (
    <div className={'metric' + (summary.bankrupt ? ' lab-out' : '')}>
      <div className="metric-head">
        <span><span className="lab-owner-dot" style={{ background: SEAT_COLORS[summary.id] }} />{summary.name}</span>
        <Coins size={18} />
      </div>
      <div className="metric-number">{formatTd(summary.cash)}</div>
      <small>{detail}</small>
    </div>
  );
}

function ReplayBadge({ run, history, index }: { run: RunRecord; history: readonly RunRecord[]; index: number }) {
  const previous = history.find((h, i) => i > index && h.seed === run.seed && h.playerCount === run.playerCount);
  if (previous === undefined) return <span className="muted">first run</span>;
  const matches = previous.hash === run.hash && previous.winnerName === run.winnerName;
  return matches
    ? <span className="small-tag">✓ replay matches</span>
    : <span className="severity">✗ replay differs</span>;
}

export function RulesLabView() {
  const [lab, dispatch] = React.useReducer(labReducer, IDLE_LAB);
  const [seed, setSeed] = React.useState('tycoon-lab');
  const [playerCount, setPlayerCount] = React.useState(3);
  const [speed, setSpeed] = React.useState<SpeedKey>('normal');
  const pacing = SPEEDS[speed];
  const logRef = React.useRef<HTMLDivElement>(null);

  // The timed loop: one interval tick applies a fixed batch of deterministic
  // bot steps. Speed re-arms the interval; pausing/finishing tears it down.
  React.useEffect(() => {
    if (lab.status !== 'running') return;
    const id = window.setInterval(
      () => dispatch({ type: 'tick', maxSteps: pacing.actionsPerTick }),
      pacing.everyMs,
    );
    return () => window.clearInterval(id);
  }, [lab.status, pacing.actionsPerTick, pacing.everyMs]);

  // Keep the log pinned to the newest events; instant jump (reduced-motion
  // safe — no smooth scrolling).
  const logLength = lab.game?.log.length ?? 0;
  React.useEffect(() => {
    const el = logRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [logLength, lab.status]);

  const game = lab.game;
  const trimmedSeed = seed.trim();
  const canRun = trimmedSeed.length > 0;
  const visibleEvents = game !== null ? game.log.slice(-LOG_TAIL) : [];
  const players = game !== null ? summarizePlayers(game) : [];
  const groups = game !== null ? summarizeGroups(game) : [];
  const special = game !== null ? specialDeedCounts(game) : [];
  const turn = game?.turn;

  return (
    <div className="lab">
      <section className="panel" aria-labelledby="lab-controls-title">
        <div className="section-heading">
          <div>
            <div className="kicker">SIMULATION CONTROLS</div>
            <h2 id="lab-controls-title">Rules Lab</h2>
          </div>
          <FlaskConical size={22} className="muted" />
        </div>
        <p>
          Seeded bot-vs-bot proof of the rules engine: one budget-aware policy plays every
          seat through the deterministic engine. Same seed, same winner — run a seed twice to verify.
        </p>
        <div className="lab-controls">
          <div className="lab-field">
            <label htmlFor="lab-seed">Seed</label>
            <input
              id="lab-seed"
              type="text"
              value={seed}
              onChange={e => setSeed(e.target.value)}
              placeholder="any non-empty text"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <fieldset className="lab-field">
            <legend>Players</legend>
            <div className="lab-choices">
              {[2, 3, 4, 5].map(n =>
                <label key={n}>
                  <input
                    type="radio"
                    name="lab-players"
                    value={n}
                    checked={playerCount === n}
                    onChange={() => setPlayerCount(n)}
                  />
                  {n}
                </label>,
              )}
            </div>
          </fieldset>
          <fieldset className="lab-field">
            <legend>Speed</legend>
            <div className="lab-choices">
              {(Object.keys(SPEEDS) as SpeedKey[]).map(key =>
                <label key={key}>
                  <input
                    type="radio"
                    name="lab-speed"
                    value={key}
                    checked={speed === key}
                    onChange={() => setSpeed(key)}
                  />
                  {SPEEDS[key].label}
                </label>,
              )}
            </div>
          </fieldset>
          <div className="lab-buttons">
            <button className="lab-button" onClick={() => dispatch({ type: 'start', seed: trimmedSeed, playerCount })} disabled={!canRun}>
              <Play size={16} /> Run
            </button>
            {lab.status === 'running' &&
              <button className="lab-button ghost" onClick={() => dispatch({ type: 'pause' })}>
                <Pause size={16} /> Pause
              </button>}
            {lab.status === 'paused' &&
              <button className="lab-button ghost" onClick={() => dispatch({ type: 'resume' })}>
                <Play size={16} /> Resume
              </button>}
          </div>
        </div>
        <div className="lab-status" role="status">
          <span className={'lab-dot ' + STATUS_DOT[lab.status]} aria-hidden="true" />
          <span>{statusLine(lab)}</span>
        </div>
        {lab.history.length > 0 &&
          <>
            <div className="divider" />
            <h2>Session runs</h2>
            <p>Determinism proof — a seed run twice must produce the same winner and hash.</p>
            <div className="table-wrap lab-runs">
              <table>
                <thead>
                  <tr><th>Run</th><th>Seed</th><th>Seats</th><th>Winner</th><th>Actions</th><th>Hash</th><th>Replay</th></tr>
                </thead>
                <tbody>
                  {lab.history.map((run, index) =>
                    <tr key={`${run.seed}-${run.hash}-${index}`}>
                      <td>#{lab.history.length - index}</td>
                      <td>{run.seed}</td>
                      <td>{run.playerCount}</td>
                      <td><strong>{run.winnerName}</strong></td>
                      <td>{run.steps}</td>
                      <td>{run.hash.slice(0, 8)}…</td>
                      <td><ReplayBadge run={run} history={lab.history} index={index} /></td>
                    </tr>,
                  )}
                </tbody>
              </table>
            </div>
          </>}
        <div className="note">QA surface — not a playable board. Board rendering and hot-seat play are Phase 2.</div>
      </section>

      {game !== null
        ? <div className="metrics lab-metrics">
            {players.map(p => <LabPlayerMetric key={p.id} summary={p} />)}
          </div>
        : <div className="metrics lab-metrics">
            <div className="metric">
              <div className="metric-head"><span>No game yet</span><Users size={18} /></div>
              <div className="metric-number">—</div>
              <small>Press Run to start a seeded simulation.</small>
            </div>
          </div>}

      <div className="lab-layout">
        <div className="lab-col">
          <section className="panel" aria-labelledby="lab-state-title">
            <div className="section-heading">
              <div>
                <div className="kicker">ENGINE STATE</div>
                <h2 id="lab-state-title">Current turn</h2>
              </div>
              <Gauge size={22} className="muted" />
            </div>
            {game === null || turn === undefined
              ? <p>No game yet — press Run to start a seeded simulation.</p>
              : <div className="lab-turn-facts">
                  <span><strong>Active player:</strong> {game.players[turn.activePlayer].name} (seat {turn.activePlayer + 1})</span>
                  <span><strong>Window:</strong> {TURN_STATE_LABELS[turn.state]} · doubles ×{turn.doublesRun}</span>
                  {game.auction !== null &&
                    <span><strong>Auction:</strong> {`tile ${game.auction.tile} — ${game.auction.highBid === null ? 'no bids yet' : `high bid ${formatTd(game.auction.highBid.amount)} by ${game.players[game.auction.highBid.bidder].name}`}`}</span>}
                  {game.pendingTrade !== null &&
                    <span><strong>Trade offer:</strong> {`${game.players[game.pendingTrade.from].name} → ${game.players[game.pendingTrade.to].name} (${game.pendingTrade.give.tiles.length} tiles, ${formatTd(game.pendingTrade.give.cash)} asked)`}</span>}
                  {game.debt !== null &&
                    <span><strong>Debt:</strong> {`${game.players[game.debt.debtor].name} owes ${formatTd(game.debt.amount)} to ${game.debt.creditor === 'bank' ? 'the bank' : game.players[game.debt.creditor].name}`}</span>}
                  <span><strong>Bank pool:</strong> permits and landmark units tracked by the engine</span>
                  <span><strong>RNG state:</strong> {game.rngState.slice(0, 8)}… (seeded — replays byte-exactly)</span>
                </div>}
          </section>

          <section className="panel" aria-labelledby="lab-ownership-title">
            <div className="section-heading">
              <div>
                <div className="kicker">OWNERSHIP</div>
                <h2 id="lab-ownership-title">Deeds by district group</h2>
              </div>
              <ListOrdered size={22} className="muted" />
            </div>
            {game === null
              ? <p>No game yet — press Run to start a seeded simulation.</p>
              : <>
                  <div className="table-wrap lab-ownership">
                    <table>
                      <thead>
                        <tr><th>District</th><th>Owner</th><th>Levels</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {groups.map(row =>
                          <tr key={row.id}>
                            <td>{row.name}</td>
                            <td>
                              {row.owner !== null
                                ? <span><span className="lab-owner-dot" style={{ background: SEAT_COLORS[row.owner] }} />{game.players[row.owner].name}</span>
                                : <span className="muted">—</span>}
                            </td>
                            <td>{row.levels.map(l => (l === 5 ? '★' : String(l))).join(' · ')}</td>
                            <td>
                              {[row.landmarks > 0 ? `${row.landmarks} landmark` : null, row.mortgaged > 0 ? `${row.mortgaged} mortgaged` : null]
                                .filter(Boolean).join(' · ') || <span className="muted">—</span>}
                            </td>
                          </tr>,
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="lab-deeds">
                    <strong>Depots:</strong> {special.map(s => `${game.players[s.player].name} ${s.depots}`).join(' · ')}
                    <br />
                    <strong>Utilities:</strong> {special.map(s => `${game.players[s.player].name} ${s.utilities}`).join(' · ')}
                  </div>
                </>}
          </section>
        </div>

        <div className="lab-col">
          <section className="panel lab-log-panel" aria-labelledby="lab-log-title">
            <div className="section-heading">
              <div>
                <div className="kicker">EVENT LOG</div>
                <h2 id="lab-log-title">Game events</h2>
              </div>
              <ScrollText size={22} className="muted" />
            </div>
            {game === null
              ? <p>No game yet — the engine's append-only event log streams here while the simulation runs.</p>
              : <>
                  <p>{game.log.length} events — showing the most recent {visibleEvents.length}.</p>
                  <div className="lab-log" role="log" aria-labelledby="lab-log-title" ref={logRef}>
                    {visibleEvents.map(ev =>
                      <div className="lab-log-line" key={ev.seq}>
                        <span className="lab-log-seq">#{String(ev.seq).padStart(4, '0')}</span>
                        <span>{describeEvent(ev, game)}</span>
                      </div>,
                    )}
                  </div>
                </>}
          </section>
        </div>
      </div>
    </div>
  );
}
