/**
 * Motor autoritativo de Batalla Naval 4J.
 *
 *  - Sin E/S, sin timers, sin Date.now(): el tiempo entra como parámetro `now`.
 *  - Inmutable hacia afuera: cada función recibe el estado y devuelve un estado NUEVO + eventos.
 *    Si falla, devuelve {ok:false} y el estado original queda intacto.
 *  - Isomórfico: corre igual en Node (servidor online) y en el dispositivo (modo offline con bots).
 *  - Humanos y bots entran por la MISMA puerta: applyTurnAction().
 *
 * Los eventos salen con audiencia ('all' | {only: playerId}). Solo los públicos ('all') avanzan `seq`;
 * los privados llevan el seq vigente, así ningún cliente ve "huecos" por eventos que no le correspondían.
 */
import { CARDS, DECK_TEMPLATE, FLEET, GAME_CONFIG } from './rules';
import { Rng } from './rng';
import { buildBoard, emptyBoard, randomPlacements, validatePlacements } from './placement';
import { applyDefense, checkDefense, effectOf, isAttack, isDefense, isRecon, isValidCoord, resolveAttack, resolveRecon } from './resolve';
import type { ResolveCtx } from './resolve';
import { projectView } from './view';
import { deepClone } from './util';
import { cellKey } from './types';
import type { ErrorCode, EventMeta, LobbyView, ServerToClientEvents } from './events';
import type {
  ActionId, BotLevel, CardId, Coord, OwnBoardPatch, PlayerId, PrivateActionResult, PublicActionResult,
  PublicImpact, PublicMark, PublicSunkShip, RoomConfig, RoomId, ServerPlayer, ServerRoomState, Ship,
  ShipPlacement, TurnAction, TurnId, TurnState,
} from './types';

const N = GAME_CONFIG.boardSize;
const E = GAME_CONFIG.energy;

// ───────────────────────── Tipos de salida ─────────────────────────
export type Audience = 'all' | { only: PlayerId };
type Payload<K extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[K]>[0];
type Body<K extends keyof ServerToClientEvents> = Omit<Payload<K>, keyof EventMeta>;
export type EngineEvent = {
  [K in keyof ServerToClientEvents]: { audience: Audience; name: K; payload: Payload<K> };
}[keyof ServerToClientEvents];

export interface Fail { error: ErrorCode; message: string }
export type EngineResult =
  | { ok: true; state: ServerRoomState; events: EngineEvent[]; duplicate?: boolean }
  | ({ ok: false } & Fail);
type Emit = <K extends keyof ServerToClientEvents>(audience: Audience, name: K, body: Body<K>) => void;

const fail = (error: ErrorCode, message: string): Fail => ({ error, message });

/** ¿Este evento le corresponde a este jugador? (para filtrar en el adaptador de sockets o en la UI offline) */
export const isForPlayer = (e: EngineEvent, id: PlayerId): boolean => e.audience === 'all' || e.audience.only === id;

function run(state: ServerRoomState, now: number, fn: (s: ServerRoomState, emit: Emit) => Fail | void): EngineResult {
  const s = deepClone(state);
  const events: EngineEvent[] = [];
  const emit: Emit = (audience, name, body) => {
    const seq = audience === 'all' ? ++s.seq : s.seq;
    events.push({ audience, name, payload: { roomId: s.roomId, seq, serverTime: now, ...(body as object) } } as unknown as EngineEvent);
  };
  const f = fn(s, emit);
  if (f) return { ok: false, ...f };
  return { ok: true, state: s, events };
}

const getPlayer = (s: ServerRoomState, id: PlayerId): ServerPlayer | undefined => s.players.find((p) => p.id === id);
const alive = (s: ServerRoomState): ServerPlayer[] => s.players.filter((p) => p.status === 'active');
const humans = (s: ServerRoomState): ServerPlayer[] => s.players.filter((p) => !p.isBot);

// ───────────────────────── Sala / lobby ─────────────────────────
export interface CreateRoomOptions {
  roomId: RoomId;
  code: string;
  host: { id: PlayerId; displayName: string; reconnectToken: string };
  humanSlots: RoomConfig['humanSlots'];
  botLevel: BotLevel;
  seed: string;
  now: number;
}

function newPlayer(id: PlayerId, displayName: string, token: string, seat: number, isBot: boolean, botLevel: BotLevel | null): ServerPlayer {
  return {
    id, displayName, seat: seat as 0 | 1 | 2 | 3, isBot, botLevel, reconnectToken: token,
    connection: 'connected', socketId: null, disconnectedAt: null, status: 'active',
    ready: isBot, fleetConfirmed: isBot, consecutiveMissedTurns: 0,
    energy: E.start, hand: [], deck: [], discard: [], board: emptyBoard(),
  };
}

export function createRoom(o: CreateRoomOptions): ServerRoomState {
  return {
    roomId: o.roomId, code: o.code, phase: 'lobby', createdAt: o.now, hostId: o.host.id,
    players: [newPlayer(o.host.id, o.host.displayName, o.host.reconnectToken, 0, false, null)],
    turnOrder: [], round: 0, turn: null,
    rng: { seed: o.seed, counter: 0 },
    publicBoards: {}, knowledge: {}, seq: 0, actionLog: [], winnerId: null,
    config: { humanSlots: o.humanSlots, botLevel: o.botLevel },
    placementDeadline: null, lastProcessed: null, eliminationOrder: [],
  };
}

export function lobbyView(s: ServerRoomState): LobbyView {
  return {
    roomId: s.roomId, code: s.code, phase: s.phase, hostId: s.hostId, capacity: 4, config: s.config,
    players: s.players.map((p) => ({
      id: p.id, displayName: p.displayName, isBot: p.isBot, connection: p.connection,
      ready: s.phase === 'lobby' ? p.ready : p.fleetConfirmed,
    })),
  };
}
const emitLobby = (s: ServerRoomState, emit: Emit) => emit('all', 'lobby:update', { lobby: lobbyView(s) });

export function addHuman(state: ServerRoomState, p: { id: PlayerId; displayName: string; reconnectToken: string }, now: number): EngineResult {
  return run(state, now, (s, emit) => {
    if (s.phase !== 'lobby') return fail('INVALID_PHASE', 'La partida ya empezó');
    if (getPlayer(s, p.id)) return fail('ALREADY_IN_ROOM', 'Ya estás en esta sala');
    if (humans(s).length >= s.config.humanSlots) return fail('ROOM_FULL', 'La sala está llena');
    s.players.push(newPlayer(p.id, p.displayName, p.reconnectToken, s.players.length, false, null));
    emitLobby(s, emit);
  });
}

export function setReady(state: ServerRoomState, playerId: PlayerId, ready: boolean, now: number): EngineResult {
  return run(state, now, (s, emit) => {
    const p = getPlayer(s, playerId);
    if (!p) return fail('UNAUTHORIZED', 'Jugador desconocido');
    if (s.phase !== 'lobby') return fail('INVALID_PHASE', 'Solo se puede cambiar en el lobby');
    p.ready = ready;
    emitLobby(s, emit);
  });
}

/** Solo el anfitrión, solo en lobby. */
export function configureRoom(state: ServerRoomState, byId: PlayerId, cfg: RoomConfig, now: number): EngineResult {
  return run(state, now, (s, emit) => {
    if (byId !== s.hostId) return fail('UNAUTHORIZED', 'Solo el anfitrión puede configurar la sala');
    if (s.phase !== 'lobby') return fail('INVALID_PHASE', 'La partida ya empezó');
    if (![1, 2, 3, 4].includes(cfg.humanSlots) || !['easy', 'normal'].includes(cfg.botLevel)) return fail('INVALID_PARAMS', 'Configuración inválida');
    if (humans(s).length > cfg.humanSlots) return fail('INVALID_PARAMS', 'Ya hay más humanos que lugares');
    s.config = { humanSlots: cfg.humanSlots, botLevel: cfg.botLevel };
    emitLobby(s, emit);
  });
}

/** En lobby el jugador sale; si era el anfitrión, el cargo pasa al siguiente humano. En partida = abandono. */
export function leaveRoom(state: ServerRoomState, playerId: PlayerId, now: number): EngineResult {
  if (state.phase === 'playing') return forfeitPlayer(state, playerId, 'left', now);
  return run(state, now, (s, emit) => {
    const p = getPlayer(s, playerId);
    if (!p) return fail('UNAUTHORIZED', 'Jugador desconocido');
    if (s.phase === 'placement') {
      // Un humano que se va durante la colocación es reemplazado por un bot.
      p.isBot = true; p.botLevel = s.config.botLevel; p.displayName = `${p.displayName} (CPU)`;
      if (p.board.ships.length !== FLEET.length) p.board = buildBoard(randomPlacements(new Rng(s.rng)));
      p.fleetConfirmed = true; p.ready = true;
      emitLobby(s, emit);
      if (s.players.every((x) => x.fleetConfirmed)) beginPlaying(s, emit, now);
      return;
    }
    if (s.phase !== 'lobby') return fail('INVALID_PHASE', 'La partida terminó');
    s.players = s.players.filter((x) => x.id !== playerId);
    const nextHost = humans(s)[0];
    if (nextHost) s.hostId = nextHost.id;
    s.players.forEach((x, i) => (x.seat = i as 0 | 1 | 2 | 3));
    emitLobby(s, emit);
  });
}

/** Solo el anfitrión. Rellena con bots los lugares sin humano (humanos + bots = 4) y pasa a colocación. */
export function startPlacement(state: ServerRoomState, byId: PlayerId, now: number): EngineResult {
  return run(state, now, (s, emit) => {
    if (byId !== s.hostId) return fail('UNAUTHORIZED', 'Solo el anfitrión puede iniciar');
    if (s.phase !== 'lobby') return fail('INVALID_PHASE', 'La partida ya empezó');
    getPlayer(s, byId)!.ready = true;
    if (humans(s).some((p) => !p.ready)) return fail('INVALID_PHASE', 'Faltan jugadores por marcarse listos');
    const rng = new Rng(s.rng);
    let n = 0;
    while (s.players.length < GAME_CONFIG.maxPlayers) {
      n += 1;
      const bot = newPlayer(`bot-${n}`, `CPU ${n}`, '', s.players.length, true, s.config.botLevel);
      bot.board = buildBoard(randomPlacements(rng));
      s.players.push(bot);
    }
    s.players.forEach((x, i) => (x.seat = i as 0 | 1 | 2 | 3));
    s.phase = 'placement';
    s.placementDeadline = now + GAME_CONFIG.timing.placementSeconds * 1000;
    emitLobby(s, emit);
    emit('all', 'placement:started', { deadline: s.placementDeadline });
  });
}

// ───────────────────────── Colocación ─────────────────────────
export function submitFleet(state: ServerRoomState, playerId: PlayerId, placements: ShipPlacement[], now: number): EngineResult {
  return run(state, now, (s) => {
    const p = getPlayer(s, playerId);
    if (!p) return fail('UNAUTHORIZED', 'Jugador desconocido');
    if (s.phase !== 'placement') return fail('INVALID_PHASE', 'No es la fase de colocación');
    if (p.fleetConfirmed) return fail('INVALID_PHASE', 'Tu flota ya está confirmada');
    const check = validatePlacements(placements);
if (!check.ok) return fail('INVALID_PLACEMENT', (check as any).message || 'Posición no válida');
    p.board = buildBoard(placements);
  });
}

export function randomizeFleet(state: ServerRoomState, playerId: PlayerId, now: number): EngineResult {
  return run(state, now, (s) => {
    const p = getPlayer(s, playerId);
    if (!p) return fail('UNAUTHORIZED', 'Jugador desconocido');
    if (s.phase !== 'placement') return fail('INVALID_PHASE', 'No es la fase de colocación');
    if (p.fleetConfirmed) return fail('INVALID_PHASE', 'Tu flota ya está confirmada');
    p.board = buildBoard(randomPlacements(new Rng(s.rng)));
  });
}

export function confirmFleet(state: ServerRoomState, playerId: PlayerId, now: number): EngineResult {
  return run(state, now, (s, emit) => {
    const p = getPlayer(s, playerId);
    if (!p) return fail('UNAUTHORIZED', 'Jugador desconocido');
    if (s.phase !== 'placement') return fail('INVALID_PHASE', 'No es la fase de colocación');
    if (p.board.ships.length !== FLEET.length) return fail('INVALID_PLACEMENT', 'Primero coloca las 6 naves');
    p.fleetConfirmed = true;
    emitLobby(s, emit);
    if (s.players.every((x) => x.fleetConfirmed)) beginPlaying(s, emit, now);
  });
}

/** Al vencer el plazo: los humanos que no terminaron reciben flota aleatoria y se confirma. */
export function autoCompletePlacement(state: ServerRoomState, now: number): EngineResult {
  return run(state, now, (s, emit) => {
    if (s.phase !== 'placement') return fail('INVALID_PHASE', 'No es la fase de colocación');
    const rng = new Rng(s.rng);
    for (const p of s.players) {
      if (p.fleetConfirmed) continue;
      if (p.board.ships.length !== FLEET.length) p.board = buildBoard(randomPlacements(rng));
      p.fleetConfirmed = true;
    }
    emitLobby(s, emit);
    beginPlaying(s, emit, now);
  });
}

function beginPlaying(s: ServerRoomState, emit: Emit, now: number): void {
  const rng = new Rng(s.rng);
  s.phase = 'playing';
  s.placementDeadline = null;
  s.round = 1;
  s.turnOrder = rng.shuffle(s.players.map((p) => p.id));
  for (const p of s.players) {
    p.energy = E.start;
    p.deck = rng.shuffle(DECK_TEMPLATE); // mazo propio de 12 cartas
    p.discard = [];
    p.hand = p.deck.splice(0, GAME_CONFIG.handSize);
    s.publicBoards[p.id] = { ownerId: p.id, marks: [], sunkShips: [] };
  }
  for (const o of s.players) {
    s.knowledge[o.id] = {};
    for (const t of s.players) if (t.id !== o.id) s.knowledge[o.id][t.id] = { cellMarks: {}, notes: [] };
  }
  for (const p of s.players) emit({ only: p.id }, 'game:started', { view: projectView(s, p.id, now) });
  startTurn(s, emit, now, 0);
}

// ───────────────────────── Turnos ─────────────────────────
const isReconCard = (id: CardId): boolean => CARDS[id].category === 'recon';

function drawOne(p: ServerPlayer, rng: Rng): CardId | null {
  if (p.deck.length === 0) { p.deck = rng.shuffle(p.discard); p.discard = []; }
  return p.deck.length ? p.deck.shift()! : null;
}

function drawRecon(p: ServerPlayer, rng: Rng): CardId | null {
  let i = p.deck.findIndex(isReconCard);
  if (i < 0 && p.discard.length) { p.deck = rng.shuffle([...p.deck, ...p.discard]); p.discard = []; i = p.deck.findIndex(isReconCard); }
  return i < 0 ? null : p.deck.splice(i, 1)[0];
}

/** Roba hasta completar la mano; con el Portaaviones a flote suma 1 carta de Reconocimiento (mano hasta 4). */
function drawForTurn(p: ServerPlayer, rng: Rng): void {
  while (p.hand.length < GAME_CONFIG.handSize) { const c = drawOne(p, rng); if (!c) break; p.hand.push(c); }
  const carrier = p.board.ships.some((s) => s.type === 'carrier' && !s.sunk);
  if (carrier && p.hand.length < GAME_CONFIG.handSize + GAME_CONFIG.carrierExtraReconDraws) {
    const c = drawRecon(p, rng);
    if (c) p.hand.push(c);
  }
}

function startTurn(s: ServerRoomState, emit: Emit, now: number, idx: number): void {
  const pid = s.turnOrder[idx];
  const p = getPlayer(s, pid)!;
  const rng = new Rng(s.rng);
  p.energy = Math.min(E.cap, p.energy + E.perTurn);
  drawForTurn(p, rng);
  const sectors = s.turnOrder.filter((id) => getPlayer(s, id)!.status === 'active'); // los eliminados salen de la ruleta
  const resultSector = rng.int(sectors.length);
  const landedOn = sectors[resultSector];
  const anim = GAME_CONFIG.timing.rouletteAnimationMs;
  const turn: TurnState = {
    turnId: `r${s.round}-${pid}`, round: s.round, activePlayerId: pid, phase: 'acting',
    roulette: { sectors, resultSector, landedOn, freeChoice: landedOn === pid },
    startedAt: now, deadline: now + anim + GAME_CONFIG.timing.turnSeconds * 1000,
  };
  s.turn = turn;
  emit('all', 'turn:started', { turn });
  emit('all', 'roulette:result', { turnId: turn.turnId, sectors, resultSector, landedOn, freeChoice: turn.roulette.freeChoice, animateEndAt: now + anim });
  emit({ only: pid }, 'own:resources', { energy: p.energy, hand: [...p.hand], deckCount: p.deck.length });
}

function nextTurn(s: ServerRoomState, emit: Emit, now: number): void {
  const n = s.turnOrder.length;
  const cur = s.turnOrder.indexOf(s.turn!.activePlayerId);
  for (let step = 1; step <= n; step++) {
    const idx = (cur + step) % n;
    if (getPlayer(s, s.turnOrder[idx])!.status !== 'active') continue;
    if (cur + step >= n) s.round += 1; // dio la vuelta completa → nueva ronda
    startTurn(s, emit, now, idx);
    return;
  }
}

function eliminate(s: ServerRoomState, emit: Emit, p: ServerPlayer, status: 'eliminated' | 'forfeited', reason: 'all_ships_sunk' | 'forfeit_timeout' | 'left'): void {
  if (p.status !== 'active') return;
  p.status = status;
  s.eliminationOrder.push(p.id);
  emit('all', 'player:status', { playerId: p.id, status, connection: p.connection, reason });
}

function checkGameOver(s: ServerRoomState, emit: Emit, reason: 'last_standing' | 'forfeit'): boolean {
  const left = alive(s);
  if (left.length > 1) return false;
  const winner = left[0] ?? null;
  s.phase = 'finished';
  s.turn = null;
  s.winnerId = winner?.id ?? null;
  const fallen = [...s.eliminationOrder].reverse();
  const finalBoards: Record<PlayerId, Ship[]> = {};
  for (const p of s.players) finalBoards[p.id] = deepClone(p.board.ships);
  emit('all', 'game:over', { winnerId: s.winnerId, reason, ranking: winner ? [winner.id, ...fallen] : fallen, finalBoards });
  return true;
}

export function forfeitPlayer(state: ServerRoomState, playerId: PlayerId, reason: 'forfeit_timeout' | 'left', now: number): EngineResult {
  return run(state, now, (s, emit) => {
    const p = getPlayer(s, playerId);
    if (!p) return fail('UNAUTHORIZED', 'Jugador desconocido');
    if (s.phase !== 'playing') return fail('INVALID_PHASE', 'No hay partida en curso');
    if (p.status !== 'active') return;
    const wasActive = s.turn?.activePlayerId === playerId;
    eliminate(s, emit, p, 'forfeited', reason);
    if (checkGameOver(s, emit, 'forfeit')) return;
    if (wasActive) nextTurn(s, emit, now);
  });
}

export function setConnection(state: ServerRoomState, playerId: PlayerId, connected: boolean, now: number): EngineResult {
  return run(state, now, (s, emit) => {
    const p = getPlayer(s, playerId);
    if (!p) return fail('UNAUTHORIZED', 'Jugador desconocido');
    p.connection = connected ? 'connected' : 'disconnected';
    p.disconnectedAt = connected ? null : now;
    if (s.phase === 'lobby' || s.phase === 'placement') emitLobby(s, emit);
    emit('all', 'player:status', { playerId, status: p.status, connection: p.connection, reason: connected ? 'reconnected' : 'disconnected' });
  });
}

// ───────────────────────── Validación de acciones ─────────────────────────
function checkTarget(s: ServerRoomState, actor: ServerPlayer, targetId: PlayerId): Fail | null {
  const t = typeof targetId === 'string' ? getPlayer(s, targetId) : undefined;
  if (!t || t.status !== 'active' || t.id === actor.id) return fail('INVALID_TARGET', 'Objetivo inválido');
  const roulette = s.turn!.roulette;
  if (!roulette.freeChoice && roulette.landedOn !== targetId) return fail('INVALID_TARGET', 'La ruleta eligió a otro jugador');
  return null;
}

function validateAction(s: ServerRoomState, actor: ServerPlayer, a: TurnAction): Fail | null {
  if (!a || typeof a !== 'object') return fail('INVALID_PARAMS', 'Acción inválida');
  if (a.kind === 'basic_shot') {
    const bad = checkTarget(s, actor, a.targetId);
    if (bad) return bad;
    if (!isValidCoord(a.at)) return fail('INVALID_COORD', 'Coordenada fuera del tablero');
    const sunkHere = s.publicBoards[a.targetId].marks.some((m) => m.kind === 'sunk' && m.coord.r === a.at.r && m.coord.c === a.at.c);
    return sunkHere ? fail('INVALID_COORD', 'Esa casilla pertenece a una nave ya hundida') : null;
  }
  if (a.kind !== 'card') return fail('INVALID_PARAMS', 'Tipo de acción desconocido');
  const def = CARDS[a.cardId];
  if (!def) return fail('INVALID_PARAMS', 'Carta desconocida');
  if (!actor.hand.includes(a.cardId)) return fail('CARD_NOT_IN_HAND', 'Esa carta no está en tu mano');
  if (actor.energy < def.cost) return fail('INSUFFICIENT_ENERGY', `Necesitas ${def.cost} de energía (tienes ${actor.energy})`);
  if (isDefense(a)) {
    const msg = checkDefense(actor.board, a);
    return msg ? fail('INVALID_PARAMS', msg) : null;
  }
  const bad = checkTarget(s, actor, a.targetId);
  if (bad) return bad;
  const coordErr = fail('INVALID_COORD', 'Coordenada fuera del tablero');
  switch (a.cardId) {
    case 'cross_attack': case 'missile_rain': case 'sonar_sweep':
      return isValidCoord(a.center) ? null : coordErr;
    case 'chain_mortar': case 'depth_torpedo':
      return isValidCoord(a.at) ? null : coordErr;
    case 'spy_drone': {
      const { w, h } = effectOf('spy_drone', 'recon_area_exact').area;
      return isValidCoord(a.topLeft) && a.topLeft.r + h <= N && a.topLeft.c + w <= N ? null : coordErr;
    }
    case 'thermal_radar':
      return (a.axis === 'row' || a.axis === 'col') && Number.isInteger(a.index) && a.index >= 0 && a.index < N ? null : coordErr;
    case 'satellite_shadow':
      return null;
  }
}

// ───────────────────────── Aplicar una acción de turno ─────────────────────────
function upsertMark(pb: { marks: PublicMark[] }, m: PublicMark): void {
  pb.marks = pb.marks.filter((x) => !(x.coord.r === m.coord.r && x.coord.c === m.coord.c));
  pb.marks.push(m);
}

/**
 * ÚNICA puerta de entrada para jugar un turno: la usan humanos (vía socket) y bots (vía GameSession).
 * `auto: true` = la jugó un bot o el piloto automático (timeout / desconexión).
 */
export function applyTurnAction(
  state: ServerRoomState, playerId: PlayerId, turnId: TurnId, actionId: ActionId, action: TurnAction, now: number,
  opts: { auto?: boolean } = {},
): EngineResult {
  // Idempotencia: un reintento de la misma acción ya aplicada no hace nada.
  if (state.lastProcessed && state.lastProcessed.turnId === turnId && state.lastProcessed.actionId === actionId) {
    return { ok: true, state, events: [], duplicate: true };
  }
  return run(state, now, (s, emit) => {
    if (s.phase !== 'playing' || !s.turn || s.turn.phase !== 'acting') return fail('INVALID_PHASE', 'No hay un turno en curso');
    if (s.turn.turnId !== turnId) return fail('STALE_TURN', 'Ese turno ya pasó');
    if (s.turn.activePlayerId !== playerId) return fail('NOT_YOUR_TURN', 'No es tu turno');
    const actor = getPlayer(s, playerId)!;
    const bad = validateAction(s, actor, action);
    if (bad) return bad;

    const rng = new Rng(s.rng);
    const rngBefore = s.rng.counter;
    const round = s.round;
    s.turn.phase = 'resolving';

    // 1) Pago: la carta va al descarte y se gasta la energía.
    const cost = action.kind === 'card' ? CARDS[action.cardId].cost : 0;
    if (action.kind === 'card') {
      actor.hand.splice(actor.hand.indexOf(action.cardId), 1);
      actor.discard.push(action.cardId);
    }
    actor.energy -= cost;

    // 2) Resolución según el tipo de acción.
    if (isAttack(action)) {
      const target = getPlayer(s, action.targetId)!;
      const ctx: ResolveCtx = { round, rng, actorId: actor.id, board: target.board };
      const out = resolveAttack(ctx, action);
      const pb = s.publicBoards[target.id];
      const kn = s.knowledge[actor.id][target.id];

      // Público: SOLO impactos (con coordenadas) y naves hundidas. Nunca Agua, Escudo ni Humo.
      const impacts: PublicImpact[] = [];
      for (const sh of out.shots) {
        if (sh.result.kind !== 'hit') continue;
        impacts.push({ coord: sh.coord, kind: sh.result.sunk ? 'sunk' : 'hit' });
        upsertMark(pb, { coord: sh.coord, kind: 'hit', round, byPlayerId: actor.id });
        delete kn.cellMarks[cellKey(sh.coord)];
      }
      const sunkPublic: PublicSunkShip[] = [];
      for (const ship of out.sunkShips) {
        for (const c of ship.cells) upsertMark(pb, { coord: c, kind: 'sunk', round, byPlayerId: actor.id });
        const entry: PublicSunkShip = { shipType: ship.type, cells: ship.cells.map((c) => ({ ...c })), sunkBy: actor.id, round };
        pb.sunkShips.push(entry);
        sunkPublic.push(entry);
      }
      // Privado (solo el atacante): Agua. Incluye fallos, Humo, Escudo y "sin efecto" (indistinguibles).
      const newCellMarks: PrivateActionResult['newCellMarks'] = [];
      for (const sh of out.shots) {
        if (sh.result.kind === 'hit') continue;
        const mark = { kind: 'water' as const, round };
        kn.cellMarks[cellKey(sh.coord)] = mark;
        newCellMarks.push({ coord: sh.coord, mark });
      }
      // Energía: +onHit si hubo impacto, +onSink por cada nave hundida (el remate cuenta igual).
      const hitBonus = impacts.length ? E.onHit : 0;
      const sinkBonus = out.sunkShips.length * E.onSink;
      actor.energy = Math.min(E.cap, actor.energy + hitBonus + sinkBonus);

      const publicResult: PublicActionResult = {
        turnId, actorId: actor.id, targetId: target.id,
        played: action.kind === 'basic_shot' ? 'basic_shot' : action.cardId,
        impacts, sunkShips: sunkPublic, removedMarks: [],
      };
      emit('all', 'action:public', { result: publicResult });
      emit({ only: actor.id }, 'action:private', {
        result: { turnId, actionId, targetId: target.id, newCellMarks, newNotes: [], energy: { spent: cost, hitBonus, sinkBonus, total: actor.energy }, hand: [...actor.hand] },
      });
      // Parche para el dueño del tablero: casillas con hp cambiado o escudo consumido.
      const touched = out.shots.filter((x) => x.result.kind === 'hit' || x.shieldConsumed);
      if (touched.length) {
        const patch: OwnBoardPatch = {
          cells: touched.map((x) => ({ coord: x.coord, cell: deepClone(target.board.cells[x.coord.r][x.coord.c]) })),
          ships: deepClone(target.board.ships.filter((sh) => touched.some((x) => x.result.kind === 'hit' && x.result.shipId === sh.id))),
        };
        emit({ only: target.id }, 'own:update', { patch });
      }
      if (target.board.ships.every((sh) => sh.sunk)) eliminate(s, emit, target, 'eliminated', 'all_ships_sunk');
    } else if (isRecon(action)) {
      const target = getPlayer(s, action.targetId)!;
      const out = resolveRecon({ round, rng, actorId: actor.id, board: target.board }, action);
      const kn = s.knowledge[actor.id][target.id];
      for (const { coord, mark } of out.cellMarks) kn.cellMarks[cellKey(coord)] = mark;
      kn.notes.push(...out.notes);
      emit('all', 'action:public', {
        result: { turnId, actorId: actor.id, targetId: target.id, played: action.cardId, impacts: [], sunkShips: [], removedMarks: [] },
      });
      emit({ only: actor.id }, 'action:private', {
        result: { turnId, actionId, targetId: target.id, newCellMarks: out.cellMarks, newNotes: out.notes, energy: { spent: cost, hitBonus: 0, sinkBonus: 0, total: actor.energy }, hand: [...actor.hand] },
      });
    } else if (isDefense(action)) {
      const out = applyDefense({ round, rng, actorId: actor.id, board: actor.board }, action);
      if (out.removedMarks.length) {
        const pb = s.publicBoards[actor.id];
        pb.marks = pb.marks.filter((m) => !out.removedMarks.some((c) => c.r === m.coord.r && c.c === m.coord.c));
      }
      emit('all', 'action:public', {
        result: { turnId, actorId: actor.id, targetId: null, played: 'defense', impacts: [], sunkShips: [], removedMarks: out.removedMarks },
      });
      emit({ only: actor.id }, 'action:private', {
        result: { turnId, actionId, targetId: null, newCellMarks: [], newNotes: [], energy: { spent: cost, hitBonus: 0, sinkBonus: 0, total: actor.energy }, hand: [...actor.hand] },
      });
      const uniq = new Map<string, Coord>();
      out.changedCells.forEach((c) => uniq.set(cellKey(c), c));
      emit({ only: actor.id }, 'own:update', {
        patch: {
          cells: [...uniq.values()].map((c) => ({ coord: c, cell: deepClone(actor.board.cells[c.r][c.c]) })),
          ships: deepClone(out.changedShips),
        },
      });
    }

    // 3) Contabilidad de turnos perdidos (solo humanos).
    let forfeited = false;
    if (!actor.isBot) {
      if (opts.auto) {
        actor.consecutiveMissedTurns += 1;
        if (actor.consecutiveMissedTurns >= GAME_CONFIG.timing.maxConsecutiveMissedTurns) {
          eliminate(s, emit, actor, 'forfeited', 'forfeit_timeout');
          forfeited = true;
        }
      } else {
        actor.consecutiveMissedTurns = 0;
      }
    }

    s.lastProcessed = { turnId, actionId };
    s.actionLog.push({ seq: s.seq, turnId, round, playerId, action, auto: !!opts.auto, rngCounterBefore: rngBefore, at: now });

    // 4) ¿Terminó la partida? Si no, sigue el próximo jugador vivo.
    if (!checkGameOver(s, emit, forfeited ? 'forfeit' : 'last_standing')) nextTurn(s, emit, now);
  });
}
