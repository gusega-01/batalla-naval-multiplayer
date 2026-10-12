/**
 * Resolución de cartas y disparos como funciones sin E/S.
 * Reciben un ResolveCtx con el tablero OBJETIVO ya clonado por el motor: mutan solo ese clon y devuelven
 * un resultado descriptivo. El motor decide después qué es público, qué es privado y qué recompensas hay.
 */
import { CARDS, GAME_CONFIG, SHIP_SPECS } from './rules';
import type { CardEffect } from './rules';
import type { Rng } from './rng';
import type {
  Area, AttackCardId, BasicShotAction, CardAction, CardId, Coord, DefenseCardId, Direction, PlayerId,
  PrivateCellMark, ReconCardId, ReconNote, ServerBoard, Ship, ShipId, TurnAction,
} from './types';

const N = GAME_CONFIG.boardSize;

export type AttackAction = BasicShotAction | Extract<CardAction, { cardId: AttackCardId }>;
export type ReconAction = Extract<CardAction, { cardId: ReconCardId }>;
export type DefenseAction = Extract<CardAction, { cardId: DefenseCardId }>;

export const isAttack = (a: TurnAction): a is AttackAction => a.kind === 'basic_shot' || CARDS[a.cardId]?.category === 'attack';
export const isRecon = (a: TurnAction): a is ReconAction => a.kind === 'card' && CARDS[a.cardId]?.category === 'recon';
export const isDefense = (a: TurnAction): a is DefenseAction => a.kind === 'card' && CARDS[a.cardId]?.category === 'defense';

// ───────────── Geometría ─────────────
export const inBounds = (c: Coord): boolean => c.r >= 0 && c.r < N && c.c >= 0 && c.c < N;
export function isValidCoord(c: Coord | null | undefined): c is Coord {
  return !!c && Number.isInteger(c.r) && Number.isInteger(c.c) && inBounds(c);
}
export const neighbors4 = (c: Coord): Coord[] =>
  [{ r: c.r - 1, c: c.c }, { r: c.r + 1, c: c.c }, { r: c.r, c: c.c - 1 }, { r: c.r, c: c.c + 1 }].filter(inBounds);

/** Área w×h centrada en `center`, recortada al tablero. */
export function areaAround(center: Coord, w: number, h: number): { topLeft: Coord; area: Area; cells: Coord[] } {
  const hr = Math.floor(h / 2), hc = Math.floor(w / 2);
  const r0 = Math.max(0, center.r - hr), r1 = Math.min(N - 1, center.r + hr);
  const c0 = Math.max(0, center.c - hc), c1 = Math.min(N - 1, center.c + hc);
  const cells: Coord[] = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.push({ r, c });
  return { topLeft: { r: r0, c: c0 }, area: { w: c1 - c0 + 1, h: r1 - r0 + 1 }, cells };
}
export function rectCells(topLeft: Coord, w: number, h: number): Coord[] {
  const cells: Coord[] = [];
  for (let r = topLeft.r; r < topLeft.r + h; r++) for (let c = topLeft.c; c < topLeft.c + w; c++) if (inBounds({ r, c })) cells.push({ r, c });
  return cells;
}

export function effectOf<T extends CardEffect['type']>(id: CardId, type: T): Extract<CardEffect, { type: T }> {
  const e = CARDS[id].effect;
  if (e.type !== type) throw new Error(`La carta ${id} no tiene un efecto '${type}'`);
  return e as Extract<CardEffect, { type: T }>;
}

export interface ResolveCtx {
  /** Ronda actual (para el Humo). */
  round: number;
  rng: Rng;
  actorId: PlayerId;
  /** Tablero sobre el que se actúa: el del objetivo (ataque/reconocimiento) o el propio (defensa). */
  board: ServerBoard;
}

const shipById = (board: ServerBoard, id: ShipId): Ship => {
  const s = board.ships.find((x) => x.id === id);
  if (!s) throw new Error(`Nave inexistente: ${id}`);
  return s;
};

// ───────────── Ataque ─────────────
export type ShotResult =
  | { kind: 'miss' } // agua, Humo o Escudo: el atacante NO distingue entre ellos
  | { kind: 'no_effect' } // casilla de nave ya destruida
  | { kind: 'hit'; shipId: ShipId; cellDestroyed: boolean; sunk: boolean };

export interface ShotRecord {
  coord: Coord;
  result: ShotResult;
  shieldConsumed: boolean;
}
export interface AttackOutcome {
  shots: ShotRecord[];
  sunkShips: Ship[];
}

export function fireShot(ctx: ResolveCtx, coord: Coord, opts: { ignoresShield: boolean; ignoresSmoke: boolean }): ShotRecord {
  const cell = ctx.board.cells[coord.r][coord.c];
  const miss: ShotRecord = { coord, result: { kind: 'miss' }, shieldConsumed: false };
  if (cell.shipId === null) return miss;
  if (cell.hp <= 0) return { coord, result: { kind: 'no_effect' }, shieldConsumed: false };
  if (!opts.ignoresSmoke && cell.smokeUntilRound >= ctx.round) return miss;
  if (!opts.ignoresShield && cell.shieldCharges > 0) {
    cell.shieldCharges -= 1;
    return { ...miss, shieldConsumed: true };
  }
  cell.hp -= 1;
  const ship = shipById(ctx.board, cell.shipId);
  let sunk = false;
  if (cell.hp === 0 && ship.cells.every(({ r, c }) => ctx.board.cells[r][c].hp === 0)) {
    ship.sunk = true;
    ship.sunkBy = ctx.actorId;
    sunk = true;
  }
  return { coord, result: { kind: 'hit', shipId: ship.id, cellDestroyed: cell.hp === 0, sunk }, shieldConsumed: false };
}

export function resolveAttack(ctx: ResolveCtx, a: AttackAction): AttackOutcome {
  const plain = { ignoresShield: false, ignoresSmoke: false };
  const shots: ShotRecord[] = [];
  if (a.kind === 'basic_shot') {
    shots.push(fireShot(ctx, a.at, plain));
  } else {
    switch (a.cardId) {
      case 'cross_attack': {
        for (const o of effectOf('cross_attack', 'attack_pattern').offsets) {
          const c = { r: a.center.r + o.r, c: a.center.c + o.c };
          if (inBounds(c)) shots.push(fireShot(ctx, c, plain));
        }
        break;
      }
      case 'missile_rain': {
        const e = effectOf('missile_rain', 'attack_scatter');
        const { cells } = areaAround(a.center, e.area.w, e.area.h);
        for (const c of ctx.rng.shuffle(cells).slice(0, e.shots)) shots.push(fireShot(ctx, c, plain));
        break;
      }
      case 'chain_mortar': {
        const e = effectOf('chain_mortar', 'attack_chain');
        let cur = a.at;
        let rec = fireShot(ctx, cur, plain);
        shots.push(rec);
        let chain = 0;
        while (rec.result.kind === 'hit' && chain < e.maxChain) {
          cur = ctx.rng.pick(neighbors4(cur));
          rec = fireShot(ctx, cur, plain);
          shots.push(rec);
          chain += 1;
        }
        break;
      }
      case 'depth_torpedo': {
        const e = effectOf('depth_torpedo', 'attack_single');
        shots.push(fireShot(ctx, a.at, { ignoresShield: e.ignoresShield, ignoresSmoke: e.ignoresSmoke }));
        break;
      }
    }
  }
  const sunkShips: Ship[] = [];
  for (const s of shots) {
    if (s.result.kind === 'hit' && s.result.sunk) {
      const ship = shipById(ctx.board, s.result.shipId);
      if (!sunkShips.includes(ship)) sunkShips.push(ship);
    }
  }
  return { shots, sunkShips };
}

// ───────────── Reconocimiento (solo lectura del tablero) ─────────────
export interface ReconOutcome {
  cellMarks: Array<{ coord: Coord; mark: PrivateCellMark }>;
  notes: ReconNote[];
}

/** ¿Hay una nave en pie en esta casilla que este reconocimiento pueda ver? (Humo e inmunidad del Submarino la ocultan) */
function visibleShipCell(ctx: ResolveCtx, c: Coord, ignoresImmunity: boolean): boolean {
  const cell = ctx.board.cells[c.r][c.c];
  if (cell.shipId === null || cell.hp <= 0) return false;
  if (cell.smokeUntilRound >= ctx.round) return false;
  if (SHIP_SPECS[shipById(ctx.board, cell.shipId).type].basicReconImmune && !ignoresImmunity) return false;
  return true;
}

export function resolveRecon(ctx: ResolveCtx, a: ReconAction): ReconOutcome {
  const round = ctx.round;
  const out: ReconOutcome = { cellMarks: [], notes: [] };
  switch (a.cardId) {
    case 'sonar_sweep': {
      const e = effectOf('sonar_sweep', 'recon_area_presence');
      const { topLeft, area, cells } = areaAround(a.center, e.area.w, e.area.h);
      out.notes.push({ kind: 'area_presence', source: 'sonar_sweep', topLeft, area, present: cells.some((c) => visibleShipCell(ctx, c, false)), round });
      break;
    }
    case 'spy_drone': {
      const e = effectOf('spy_drone', 'recon_area_exact');
      for (const c of rectCells(a.topLeft, e.area.w, e.area.h)) {
        out.cellMarks.push({ coord: c, mark: { kind: visibleShipCell(ctx, c, false) ? 'recon_ship' : 'recon_empty', round } });
      }
      break;
    }
    case 'thermal_radar': {
      let count = 0;
      for (let i = 0; i < N; i++) {
        const c = a.axis === 'row' ? { r: a.index, c: i } : { r: i, c: a.index };
        if (visibleShipCell(ctx, c, false)) count++;
      }
      out.notes.push({ kind: 'line_count', source: 'thermal_radar', axis: a.axis, index: a.index, count, round });
      break;
    }
    case 'satellite_shadow': {
      const e = effectOf('satellite_shadow', 'recon_random_ship_cell');
      const candidates: Coord[] = [];
      for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
          const cell = ctx.board.cells[r][c];
          if (!visibleShipCell(ctx, { r, c }, e.ignoresBasicReconImmunity)) continue;
          const spec = SHIP_SPECS[shipById(ctx.board, cell.shipId as ShipId).type];
          if (cell.hp === spec.hpPerCell) candidates.push({ r, c }); // solo casillas sin daño: lo ya impactado es público
        }
      }
      if (candidates.length) out.cellMarks.push({ coord: ctx.rng.pick(candidates), mark: { kind: 'recon_ship', round } });
      break;
    }
  }
  return out;
}

// ───────────── Defensa (muta el tablero propio) ─────────────
const DIRS: Record<Direction, Coord> = { up: { r: -1, c: 0 }, down: { r: 1, c: 0 }, left: { r: 0, c: -1 }, right: { r: 0, c: 1 } };

export interface DefenseOutcome {
  changedCells: Coord[];
  changedShips: Ship[];
  /** Marcas públicas que hay que retirar (solo Reparación). */
  removedMarks: Coord[];
}

/** Devuelve un mensaje de error o null si la defensa es legal. */
export function checkDefense(board: ServerBoard, a: DefenseAction): string | null {
  switch (a.cardId) {
    case 'tactical_shift': {
      const ship = board.ships.find((s) => s.id === a.shipId);
      if (!ship) return 'Esa nave no existe';
      if (ship.sunk) return 'La nave está hundida';
      const spec = SHIP_SPECS[ship.type];
      if (ship.cells.some(({ r, c }) => board.cells[r][c].hp !== spec.hpPerCell)) return 'Solo se pueden mover naves sin daño';
      const d = DIRS[a.direction];
      if (!d) return 'Dirección inválida';
      for (const c of ship.cells) {
        const n = { r: c.r + d.r, c: c.c + d.c };
        if (!inBounds(n)) return 'La nave se saldría del tablero';
        const cell = board.cells[n.r][n.c];
        if (cell.shipId !== null && cell.shipId !== ship.id) return 'Hay otra nave en el camino';
      }
      return null;
    }
    case 'smoke_screen':
      return isValidCoord(a.center) ? null : 'Casilla inválida';
    case 'em_shield': {
      if (!isValidCoord(a.at)) return 'Casilla inválida';
      const cell = board.cells[a.at.r][a.at.c];
      if (cell.shipId === null || cell.hp <= 0) return 'El escudo va sobre una casilla de nave en pie';
      if (cell.shieldCharges > 0) return 'Esa casilla ya tiene escudo';
      return null;
    }
    case 'emergency_repair': {
      if (!isValidCoord(a.at)) return 'Casilla inválida';
      const cell = board.cells[a.at.r][a.at.c];
      if (cell.shipId === null) return 'No hay nave en esa casilla';
      const ship = shipById(board, cell.shipId);
      if (ship.sunk) return 'No se puede reparar una nave hundida';
      if (cell.hp >= SHIP_SPECS[ship.type].hpPerCell) return 'Esa casilla no está dañada';
      return null;
    }
  }
}

/** Asume que checkDefense ya devolvió null. */
export function applyDefense(ctx: ResolveCtx, a: DefenseAction): DefenseOutcome {
  const board = ctx.board;
  const out: DefenseOutcome = { changedCells: [], changedShips: [], removedMarks: [] };
  switch (a.cardId) {
    case 'tactical_shift': {
      const ship = shipById(board, a.shipId);
      const spec = SHIP_SPECS[ship.type];
      const d = DIRS[a.direction];
      const oldCells = ship.cells;
      const newCells = oldCells.map((c) => ({ r: c.r + d.r, c: c.c + d.c }));
      for (const { r, c } of oldCells) { board.cells[r][c].shipId = null; board.cells[r][c].hp = 0; }
      for (const { r, c } of newCells) { board.cells[r][c].shipId = ship.id; board.cells[r][c].hp = spec.hpPerCell; }
      ship.cells = newCells;
      out.changedCells.push(...oldCells, ...newCells);
      out.changedShips.push(ship);
      break;
    }
    case 'smoke_screen': {
      const e = effectOf('smoke_screen', 'smoke');
      for (const c of areaAround(a.center, e.area.w, e.area.h).cells) {
        // Activo durante la ronda actual y las (durationRounds - 1) siguientes.
        board.cells[c.r][c.c].smokeUntilRound = ctx.round + e.durationRounds - 1;
        out.changedCells.push(c);
      }
      break;
    }
    case 'em_shield': {
      board.cells[a.at.r][a.at.c].shieldCharges += effectOf('em_shield', 'shield').charges;
      out.changedCells.push(a.at);
      break;
    }
    case 'emergency_repair': {
      const cell = board.cells[a.at.r][a.at.c];
      const ship = shipById(board, cell.shipId as ShipId);
      cell.hp += effectOf('emergency_repair', 'repair').cells;
      out.changedCells.push(a.at);
      out.changedShips.push(ship);
      if (cell.hp >= SHIP_SPECS[ship.type].hpPerCell) out.removedMarks.push(a.at);
      break;
    }
  }
  return out;
}
