/**
 * Batalla Naval 4J — Reglas como datos: configuración, naves y las 12 cartas.
 * Los comentarios "SUPUESTO" marcan efectos que hay que confirmar.
 */
import type { Area, CardCategory, CardId, Coord, Ship, ServerBoard, ShipType } from './types';

// ───────────────────────── Configuración ─────────────────────────
export const GAME_CONFIG = {
  boardSize: 12,
  maxPlayers: 4,

  /** Se roba hasta completar la mano al empezar el turno (si jugaste disparo básico, no hay robo). */
  handSize: 3,
  /** SUPUESTO: con el Portaaviones a flote, al robar se suma 1 carta de Reconocimiento (mano puede llegar a 4). */
  carrierExtraReconDraws: 1,

  energy: {
    start: 3,
    /** Se suma al inicio de cada turno propio (incluido el primero) con tope en cap. */
    perTurn: 2,
    cap: 6,
    /** Tras la acción: +1 si hubo al menos un impacto. */
    onHit: 1,
    /** +1 por cada nave hundida en esa acción (remate incluido). */
    onSink: 1,
  },

  timing: {
    /** Duración de la animación de la ruleta; se suma al plazo del turno. */
    rouletteAnimationMs: 2500,
    placementSeconds: 60,
    turnSeconds: 20,
    reconnectGraceSeconds: 40,
    /** Con este número de turnos perdidos seguidos el jugador queda eliminado por abandono. */
    maxConsecutiveMissedTurns: 3,
  },
} as const;

// ───────────────────────── Naves ─────────────────────────
export interface ShipSpec {
  type: ShipType;
  name: string;
  length: number;
  /** hp de cada casilla (el Acorazado es 2). */
  hpPerCell: number;
  /** true = inmune a Sónar, Dron y Radar (no a Sombra Satelital). */
  basicReconImmune: boolean;
}

export const SHIP_SPECS: Record<ShipType, ShipSpec> = {
  carrier: { type: 'carrier', name: 'Portaaviones', length: 5, hpPerCell: 1, basicReconImmune: false },
  battleship: { type: 'battleship', name: 'Acorazado', length: 4, hpPerCell: 2, basicReconImmune: false },
  cruiser: { type: 'cruiser', name: 'Crucero', length: 3, hpPerCell: 1, basicReconImmune: false },
  submarine: { type: 'submarine', name: 'Submarino', length: 3, hpPerCell: 1, basicReconImmune: true },
  destroyer: { type: 'destroyer', name: 'Destructor', length: 2, hpPerCell: 1, basicReconImmune: false },
  patrol: { type: 'patrol', name: 'Lancha Patrullera', length: 1, hpPerCell: 1, basicReconImmune: false },
};

/** Flota completa: 6 naves, 18 casillas. */
export const FLEET: readonly ShipType[] = ['carrier', 'battleship', 'cruiser', 'submarine', 'destroyer', 'patrol'];

// ───────────────────────── Remate ─────────────────────────
/** Casillas de la nave que siguen en pie (hp > 0). */
export function remainingCells(board: ServerBoard, ship: Ship): number {
  return ship.cells.filter(({ r, c }) => board.cells[r][c].hp > 0).length;
}

/**
 * Remate: una nave de 2+ casillas queda expuesta cuando le resta SOLO 1 casilla en pie.
 * (Destructor tras 1 impacto, Crucero tras 2, ...). La Lancha nunca queda "tocada": se hunde de una.
 */
export function isFinishable(board: ServerBoard, ship: Ship): boolean {
  return !ship.sunk && ship.cells.length > 1 && remainingCells(board, ship) === 1;
}

// ───────────────────────── Cartas ─────────────────────────
export type CardEffect =
  // Ataque
  | { type: 'attack_pattern'; offsets: readonly Coord[] }
  | { type: 'attack_scatter'; area: Area; shots: number }
  | { type: 'attack_chain'; maxChain: number }
  | { type: 'attack_single'; ignoresShield: boolean; ignoresSmoke: boolean }
  // Reconocimiento
  | { type: 'recon_area_presence'; area: Area }
  | { type: 'recon_area_exact'; area: Area }
  | { type: 'recon_line_count' }
  | { type: 'recon_random_ship_cell'; ignoresBasicReconImmunity: boolean }
  // Defensa / utilidad
  | { type: 'move_ship'; maxDistance: number; onlyUndamaged: boolean }
  | { type: 'smoke'; area: Area; durationRounds: number }
  | { type: 'shield'; charges: number }
  | { type: 'repair'; cells: number };

export interface CardDefinition {
  id: CardId;
  name: string;
  category: CardCategory;
  /** Costo en energía. */
  cost: number;
  /**
   * 'opponent' = respeta la ruleta (rival obligado, o libre entre rivales vivos si hubo Elección Libre).
   * 'self'     = siempre sobre el propio tablero; la ruleta no interviene.
   */
  target: 'opponent' | 'self';
  description: string;
  effect: CardEffect;
}

export const CARDS: Record<CardId, CardDefinition> = {
  // ── ATAQUE ──────────────────────────────────────────────
  depth_torpedo: {
    id: 'depth_torpedo',
    name: 'Torpedo de Profundidad',
    category: 'attack',
    cost: 2,
    target: 'opponent',
    description: 'Disparo a 1 casilla que atraviesa Escudo Electromagnético y Pantalla de Humo.',
    // SUPUESTO: su nicho es contrarrestar la defensa, no el Submarino (los ataques sí impactan al Submarino).
    effect: { type: 'attack_single', ignoresShield: true, ignoresSmoke: true },
  },
  cross_attack: {
    id: 'cross_attack',
    name: 'Ataque en Cruz',
    category: 'attack',
    cost: 3,
    target: 'opponent',
    description: 'Impacta la casilla elegida y sus 4 vecinas ortogonales (5 casillas).',
    effect: {
      type: 'attack_pattern',
      offsets: [
        { r: 0, c: 0 },
        { r: -1, c: 0 },
        { r: 1, c: 0 },
        { r: 0, c: -1 },
        { r: 0, c: 1 },
      ],
    },
  },
  missile_rain: {
    id: 'missile_rain',
    name: 'Lluvia de Misiles',
    category: 'attack',
    cost: 3,
    target: 'opponent',
    description: 'Cae dispersa sobre un área de 3x3: 4 casillas al azar de las 9.',
    // SUPUESTO: shots = 4 de 9 (distintas, elegidas por el RNG del servidor).
    effect: { type: 'attack_scatter', area: { w: 3, h: 3 }, shots: 4 },
  },
  chain_mortar: {
    id: 'chain_mortar',
    name: 'Mortero en Cadena',
    category: 'attack',
    cost: 3,
    target: 'opponent',
    description: 'Dispara a 1 casilla; si impacta, encadena un nuevo disparo a una vecina al azar (hasta 2 veces).',
    // SUPUESTO: la cadena solo continúa mientras haya impacto y no tiene en cuenta casillas ya destruidas.
    effect: { type: 'attack_chain', maxChain: 2 },
  },

  // ── RECONOCIMIENTO (resultado privado) ──────────────────
  sonar_sweep: {
    id: 'sonar_sweep',
    name: 'Sónar de Barrido',
    category: 'recon',
    cost: 2,
    target: 'opponent',
    description: 'Barre un área de 3x3 e indica solo si hay alguna nave (sin posiciones).',
    // SUPUESTO: informa presencia sí/no del área. No detecta Submarino.
    effect: { type: 'recon_area_presence', area: { w: 3, h: 3 } },
  },
  spy_drone: {
    id: 'spy_drone',
    name: 'Dron Espía',
    category: 'recon',
    cost: 2,
    target: 'opponent',
    description: 'Revela con exactitud las 4 casillas de un área de 2x2. No detecta Submarino.',
    effect: { type: 'recon_area_exact', area: { w: 2, h: 2 } },
  },
  thermal_radar: {
    id: 'thermal_radar',
    name: 'Radar Térmico',
    category: 'recon',
    cost: 2,
    target: 'opponent',
    description: 'Cuenta las casillas ocupadas de una fila o columna completa. No cuenta el Submarino.',
    effect: { type: 'recon_line_count' },
  },
  satellite_shadow: {
    id: 'satellite_shadow',
    name: 'Sombra Satelital',
    category: 'recon',
    cost: 2,
    target: 'opponent',
    description: 'Revela 1 casilla de nave aún en pie, elegida al azar. Detecta incluso al Submarino.',
    // SUPUESTO: es el único reconocimiento que ignora la inmunidad del Submarino.
    effect: { type: 'recon_random_ship_cell', ignoresBasicReconImmunity: true },
  },

  // ── DEFENSA Y UTILIDAD (siempre sobre el propio tablero) ─
  tactical_shift: {
    id: 'tactical_shift',
    name: 'Desplazamiento Táctico',
    category: 'defense',
    cost: 1,
    target: 'self',
    description: 'Mueve 1 casilla una nave sin daño. Deja obsoleta la información rival.',
    effect: { type: 'move_ship', maxDistance: 1, onlyUndamaged: true },
  },
  smoke_screen: {
    id: 'smoke_screen',
    name: 'Pantalla de Humo',
    category: 'defense',
    cost: 2,
    target: 'self',
    description: 'Un área de 3x3 de tu tablero es inmune durante 2 rondas.',
    // SUPUESTO: el atacante ve "Agua" y el reconocimiento ve "vacío"; el Torpedo de Profundidad la atraviesa.
    // Duración medida en RONDAS (no en turnos individuales).
    effect: { type: 'smoke', area: { w: 3, h: 3 }, durationRounds: 2 },
  },
  em_shield: {
    id: 'em_shield',
    name: 'Escudo Electromagnético',
    category: 'defense',
    cost: 2,
    target: 'self',
    description: 'Una casilla absorbe el próximo impacto; el atacante ve "Agua".',
    effect: { type: 'shield', charges: 1 },
  },
  emergency_repair: {
    id: 'emergency_repair',
    name: 'Reparación de Emergencia',
    category: 'defense',
    cost: 2,
    target: 'self',
    description: 'Repara 1 casilla dañada de una nave que no esté hundida. La marca de fuego pública se retira.',
    effect: { type: 'repair', cells: 1 },
  },
};

/** Lista ordenada (para UI / balance). */
export const CARD_LIST: readonly CardDefinition[] = Object.values(CARDS);

/** Cada jugador arranca con su propio mazo de las 12 cartas; el servidor lo baraja con el RNG de la partida. */
export const DECK_TEMPLATE: readonly CardId[] = Object.keys(CARDS) as CardId[];
