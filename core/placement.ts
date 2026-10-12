/**
 * Colocación de flota: validación (el servidor NUNCA confía en el cliente), construcción del tablero
 * y colocación aleatoria. Se permite que las naves se toquen (no se permite solaparlas).
 */
import { FLEET, GAME_CONFIG, SHIP_SPECS } from './rules';
import type { Rng } from './rng';
import type { Cell, Coord, Orientation, ServerBoard, Ship, ShipPlacement, ShipType } from './types';

const N = GAME_CONFIG.boardSize;

export function emptyBoard(): ServerBoard {
  return {
    ships: [],
    cells: Array.from({ length: N }, () =>
      Array.from({ length: N }, (): Cell => ({ shipId: null, hp: 0, shieldCharges: 0, smokeUntilRound: 0 })),
    ),
  };
}

export function placementCells(p: ShipPlacement): Coord[] {
  const len = SHIP_SPECS[p.type].length;
  return Array.from({ length: len }, (_, i) =>
    p.orientation === 'H' ? { r: p.origin.r, c: p.origin.c + i } : { r: p.origin.r + i, c: p.origin.c },
  );
}

export type PlacementCheck = { ok: true } | { ok: false; message: string };

export function validatePlacements(placements: ShipPlacement[]): PlacementCheck {
  if (!Array.isArray(placements) || placements.length !== FLEET.length) {
    return { ok: false, message: `La flota debe tener exactamente ${FLEET.length} naves` };
  }
  const seen = new Set<ShipType>();
  const occupied = new Set<string>();
  for (const p of placements) {
    if (!p || !SHIP_SPECS[p.type]) return { ok: false, message: 'Tipo de nave desconocido' };
    if (p.orientation !== 'H' && p.orientation !== 'V') return { ok: false, message: 'Orientación inválida' };
    if (!p.origin || !Number.isInteger(p.origin.r) || !Number.isInteger(p.origin.c)) {
      return { ok: false, message: 'Posición inválida' };
    }
    if (seen.has(p.type)) return { ok: false, message: `Nave repetida: ${SHIP_SPECS[p.type].name}` };
    seen.add(p.type);
    for (const c of placementCells(p)) {
      if (c.r < 0 || c.r >= N || c.c < 0 || c.c >= N) {
        return { ok: false, message: `${SHIP_SPECS[p.type].name} se sale del tablero` };
      }
      const key = `${c.r},${c.c}`;
      if (occupied.has(key)) return { ok: false, message: `${SHIP_SPECS[p.type].name} se solapa con otra nave` };
      occupied.add(key);
    }
  }
  for (const t of FLEET) if (!seen.has(t)) return { ok: false, message: `Falta la nave ${SHIP_SPECS[t].name}` };
  return { ok: true };
}

/** Asume placements ya validados. El id de cada nave es su tipo (hay una de cada una). */
export function buildBoard(placements: ShipPlacement[]): ServerBoard {
  const board = emptyBoard();
  for (const p of placements) {
    const spec = SHIP_SPECS[p.type];
    const cells = placementCells(p);
    const ship: Ship = { id: p.type, type: p.type, cells, sunk: false, sunkBy: null };
    board.ships.push(ship);
    for (const { r, c } of cells) {
      board.cells[r][c] = { shipId: p.type, hp: spec.hpPerCell, shieldCharges: 0, smokeUntilRound: 0 };
    }
  }
  return board;
}

export function randomPlacements(rng: Rng): ShipPlacement[] {
  const order = [...FLEET].sort((a, b) => SHIP_SPECS[b].length - SHIP_SPECS[a].length);
  for (let attempt = 0; attempt < 1000; attempt++) {
    const placements: ShipPlacement[] = [];
    const occupied = new Set<string>();
    let failed = false;
    for (const type of order) {
      let placed = false;
      for (let tries = 0; tries < 300 && !placed; tries++) {
        const orientation: Orientation = rng.chance(0.5) ? 'H' : 'V';
        const p: ShipPlacement = { type, orientation, origin: { r: rng.int(N), c: rng.int(N) } };
        const cells = placementCells(p);
        if (cells.every((c) => c.r < N && c.c < N && !occupied.has(`${c.r},${c.c}`))) {
          cells.forEach((c) => occupied.add(`${c.r},${c.c}`));
          placements.push(p);
          placed = true;
        }
      }
      if (!placed) { failed = true; break; }
    }
    if (!failed) return placements;
  }
  throw new Error('No se pudo generar una colocación aleatoria');
}

/** Inversa de buildBoard (útil para devolverle al cliente la flota aleatoria). */
export function boardToPlacements(board: ServerBoard): ShipPlacement[] {
  return board.ships.map((sh) => {
    const rs = sh.cells.map((c) => c.r);
    const cs = sh.cells.map((c) => c.c);
    const orientation: Orientation = sh.cells.length === 1 || sh.cells[0].r === sh.cells[1].r ? 'H' : 'V';
    return { type: sh.type, orientation, origin: { r: Math.min(...rs), c: Math.min(...cs) } };
  });
}
