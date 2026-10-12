/**
 * Batalla Naval 4J — Tipos de dominio y estado
 *
 * Tres "capas" de información:
 *  1. ServerRoomState  -> verdad completa. Vive SOLO en el servidor. Nunca se serializa tal cual.
 *  2. Capa pública     -> Tocado / Hundido (la ven los 4 jugadores).
 *  3. Capa privada     -> knowledge[observador][tablero]: Agua y resultados de reconocimiento
 *                         (solo la ve quien los generó).
 *  GameView = proyección que se envía a UN jugador: su tablero completo + pública + SU capa privada.
 */

// ───────────────────────── Primitivos ─────────────────────────
export type PlayerId = string;
export type RoomId = string;
export type ShipId = string; // único dentro del tablero, ej. "destroyer"
export type TurnId = string;
export type ActionId = string; // lo genera el cliente (uuid) para idempotencia

/** Coordenadas 0-based. En 12x12: r y c van de 0 a 11. */
export interface Coord {
  r: number;
  c: number;
}
export interface Area {
  w: number;
  h: number;
}
export type Axis = 'row' | 'col';
export type Orientation = 'H' | 'V';
export type Direction = 'up' | 'down' | 'left' | 'right';

/** Clave para indexar casillas en Record<string, ...> (JSON-friendly). */
export const cellKey = (c: Coord): string => `${c.r},${c.c}`;

// ───────────────────────── Naves y cartas ─────────────────────────
export type ShipType =
  | 'carrier' // Portaaviones (5)
  | 'battleship' // Acorazado (4, blindaje)
  | 'cruiser' // Crucero (3)
  | 'submarine' // Submarino (3, inmune a reconocimiento básico)
  | 'destroyer' // Destructor (2)
  | 'patrol'; // Lancha Patrullera (1)

export type AttackCardId = 'cross_attack' | 'chain_mortar' | 'missile_rain' | 'depth_torpedo';
export type ReconCardId = 'sonar_sweep' | 'spy_drone' | 'thermal_radar' | 'satellite_shadow';
export type DefenseCardId = 'tactical_shift' | 'smoke_screen' | 'em_shield' | 'emergency_repair';
export type CardId = AttackCardId | ReconCardId | DefenseCardId;
export type CardCategory = 'attack' | 'recon' | 'defense';

// ───────────────────────── Tablero (SOLO servidor) ─────────────────────────
export interface Cell {
  shipId: ShipId | null;
  /** 0 = agua o casilla destruida. 1 = normal. 2 = casilla blindada del Acorazado. */
  hp: number;
  /** Cargas de Escudo Electromagnético sobre esta casilla. */
  shieldCharges: number;
  /** Ronda hasta la cual (inclusive) hay Pantalla de Humo. 0 = sin humo. */
  smokeUntilRound: number;
}

export interface Ship {
  id: ShipId;
  type: ShipType;
  /** Posiciones ACTUALES (cambian con Desplazamiento Táctico). */
  cells: Coord[];
  sunk: boolean;
  sunkBy: PlayerId | null;
}

export interface ServerBoard {
  ships: Ship[];
  /** cells[r][c], 12x12 */
  cells: Cell[][];
}

// ───────────────────────── Capa pública ─────────────────────────
export interface PublicMark {
  coord: Coord;
  kind: 'hit' | 'sunk';
  round: number;
  byPlayerId: PlayerId;
}

export interface PublicSunkShip {
  shipType: ShipType;
  cells: Coord[];
  sunkBy: PlayerId;
  round: number;
}

/** Lo que cualquier jugador puede ver de un tablero ajeno (y del propio, como "público"). */
export interface PublicBoardState {
  ownerId: PlayerId;
  marks: PublicMark[];
  sunkShips: PublicSunkShip[];
}

// ───────────────────────── Capa privada por observador ─────────────────────────
export type PrivateCellMark =
  | { kind: 'water'; round: number } // fallo, o disparo absorbido por Escudo/Humo (indistinguible)
  | { kind: 'recon_empty'; round: number } // Dron/Sombra: casilla sin nave
  | { kind: 'recon_ship'; round: number }; // Dron/Sombra: casilla con nave

export type ReconNote =
  | { kind: 'line_count'; source: CardId; axis: Axis; index: number; count: number; round: number }
  | { kind: 'area_presence'; source: CardId; topLeft: Coord; area: Area; present: boolean; round: number };

export interface ObserverKnowledge {
  /** Clave = cellKey(coord). Cada marca va sellada con la ronda (la UI atenúa datos viejos). */
  cellMarks: Record<string, PrivateCellMark>;
  notes: ReconNote[];
}

/** knowledge[observador][dueñoDelTablero] */
export type KnowledgeMap = Record<PlayerId, Record<PlayerId, ObserverKnowledge>>;

// ───────────────────────── Acciones (cliente → servidor) ─────────────────────────
export interface ShipPlacement {
  type: ShipType;
  origin: Coord; // casilla de inicio
  orientation: Orientation; // H = hacia la derecha, V = hacia abajo
}

export interface BasicShotAction {
  kind: 'basic_shot';
  targetId: PlayerId;
  at: Coord;
}

/**
 * Un CardAction por carta, con sus parámetros exactos.
 * Las defensivas no llevan targetId: siempre se aplican al propio tablero.
 * Para las demás, el servidor valida targetId contra el resultado de la ruleta
 * (obligatorio si cayó en un rival; libre entre rivales vivos si hubo Elección Libre).
 */
export type CardAction =
  | { kind: 'card'; cardId: 'cross_attack'; targetId: PlayerId; center: Coord }
  | { kind: 'card'; cardId: 'chain_mortar'; targetId: PlayerId; at: Coord }
  | { kind: 'card'; cardId: 'missile_rain'; targetId: PlayerId; center: Coord }
  | { kind: 'card'; cardId: 'depth_torpedo'; targetId: PlayerId; at: Coord }
  | { kind: 'card'; cardId: 'sonar_sweep'; targetId: PlayerId; center: Coord }
  | { kind: 'card'; cardId: 'spy_drone'; targetId: PlayerId; topLeft: Coord }
  | { kind: 'card'; cardId: 'thermal_radar'; targetId: PlayerId; axis: Axis; index: number }
  | { kind: 'card'; cardId: 'satellite_shadow'; targetId: PlayerId }
  | { kind: 'card'; cardId: 'tactical_shift'; shipId: ShipId; direction: Direction }
  | { kind: 'card'; cardId: 'smoke_screen'; center: Coord }
  | { kind: 'card'; cardId: 'em_shield'; at: Coord }
  | { kind: 'card'; cardId: 'emergency_repair'; at: Coord };

/** Carta O disparo básico, nunca ambas. */
export type TurnAction = BasicShotAction | CardAction;

// ───────────────────────── Resultados de acción (servidor → clientes) ─────────────────────────
/** Lo que se ve públicamente de una carta jugada. Las defensivas se ocultan bajo 'defense'. */
export type PublicPlayed = 'basic_shot' | AttackCardId | ReconCardId | 'defense';

export interface PublicImpact {
  coord: Coord;
  kind: 'hit' | 'sunk';
}

/**
 * Se emite a los 4 jugadores. Regla de privacidad:
 * coordenadas SOLO si hubo impacto; nunca Agua, Escudo ni Humo.
 */
export interface PublicActionResult {
  turnId: TurnId;
  actorId: PlayerId;
  targetId: PlayerId | null; // null en cartas defensivas
  played: PublicPlayed;
  impacts: PublicImpact[];
  sunkShips: PublicSunkShip[];
  /** Reparación de Emergencia: la marca de fuego desaparece del tablero público. */
  removedMarks: Coord[];
}

/** Solo al actor: su capa privada actualizada + economía. */
export interface PrivateActionResult {
  turnId: TurnId;
  actionId: ActionId;
  targetId: PlayerId | null;
  newCellMarks: Array<{ coord: Coord; mark: PrivateCellMark }>;
  newNotes: ReconNote[];
  energy: { spent: number; hitBonus: number; sinkBonus: number; total: number };
  hand: CardId[];
}

/** Solo al dueño del tablero afectado (Escudo consumido, blindaje, Humo, nave movida...). */
export interface OwnBoardPatch {
  cells: Array<{ coord: Coord; cell: Cell }>;
  ships: Ship[]; // naves cuyo estado cambió
}

// ───────────────────────── Estado de turno ─────────────────────────
export interface RouletteState {
  /** Jugadores vivos en orden de sector. Los eliminados salen de la ruleta. */
  sectors: PlayerId[];
  resultSector: number;
  landedOn: PlayerId;
  /** true si cayó en el propio jugador en turno → Elección Libre. */
  freeChoice: boolean;
}

export interface TurnState {
  turnId: TurnId;
  round: number;
  activePlayerId: PlayerId;
  phase: 'acting' | 'resolving';
  roulette: RouletteState;
  /** Epoch ms en hora del servidor. */
  startedAt: number;
  deadline: number;
}

// ───────────────────────── ESTADO COMPLETO (SOLO servidor) ─────────────────────────
export type RoomPhase = 'lobby' | 'placement' | 'playing' | 'finished';
export type PlayerStatus = 'active' | 'eliminated' | 'forfeited';
export type ConnectionState = 'connected' | 'disconnected';

/** Dificultad de los bots (también la usa el piloto automático de un humano ausente: 'easy'). */
export type BotLevel = 'easy' | 'normal';

/** Configuración de la sala. Siempre se juega de a 4: humanos + bots = 4. */
export interface RoomConfig {
  /** Máximo de humanos que pueden unirse (1 = partida offline 1 + 3 bots). Los lugares libres los llenan bots al iniciar. */
  humanSlots: 1 | 2 | 3 | 4;
  botLevel: BotLevel;
}

export interface ServerPlayer {
  id: PlayerId;
  displayName: string;
  seat: 0 | 1 | 2 | 3;
  isBot: boolean;
  botLevel: BotLevel | null;
  /** Secreto: jamás se envía a otros jugadores ni se loguea. */
  reconnectToken: string;
  connection: ConnectionState;
  socketId: string | null;
  disconnectedAt: number | null;
  status: PlayerStatus;
  ready: boolean;
  fleetConfirmed: boolean;
  consecutiveMissedTurns: number;

  energy: number;
  hand: CardId[];
  deck: CardId[]; // mazo propio de 12, barajado con el RNG de la partida
  discard: CardId[];

  board: ServerBoard;
}

export interface RngState {
  seed: string;
  /** Cantidad de valores consumidos: (seed, counter) permite reproducir la partida. */
  counter: number;
}

export interface LoggedAction {
  seq: number;
  turnId: TurnId;
  round: number;
  playerId: PlayerId;
  action: TurnAction;
  /** true si la jugó un bot o el piloto automático (timeout / desconexión). */
  auto: boolean;
  rngCounterBefore: number;
  at: number;
}

export interface ServerRoomState {
  roomId: RoomId;
  code: string;
  phase: RoomPhase;
  createdAt: number;
  hostId: PlayerId;

  players: ServerPlayer[]; // hasta 4
  turnOrder: PlayerId[];
  round: number;
  turn: TurnState | null;

  rng: RngState;

  publicBoards: Record<PlayerId, PublicBoardState>;
  knowledge: KnowledgeMap;

  /** Contador monotónico de eventos de la sala (para detectar huecos en el cliente). */
  seq: number;
  actionLog: LoggedAction[];

  winnerId: PlayerId | null;

  config: RoomConfig;
  /** Fin de la fase de colocación (epoch ms); al vencer se auto-completa la flota. */
  placementDeadline: number | null;
  /** Última acción aplicada: permite que un reintento del cliente sea idempotente. */
  lastProcessed: { turnId: TurnId; actionId: ActionId } | null;
  /** Orden de eliminación (el primero en caer va primero). */
  eliminationOrder: PlayerId[];
}

// ───────────────────────── VISTA PROYECTADA (lo que recibe UN cliente) ─────────────────────────
export interface PublicPlayerInfo {
  id: PlayerId;
  displayName: string;
  seat: 0 | 1 | 2 | 3;
  isBot: boolean;
  status: PlayerStatus;
  connection: ConnectionState;
  handSize: number;
  shipsRemaining: number;
}

export interface OpponentBoardView {
  ownerId: PlayerId;
  /** Capa pública: la ven los 4. */
  public: PublicBoardState;
  /** Capa privada: SOLO la de este observador sobre este tablero. */
  private: ObserverKnowledge;
}

export interface GameView {
  roomId: RoomId;
  phase: RoomPhase;
  round: number;
  you: PlayerId;
  players: PublicPlayerInfo[];
  turn: TurnState | null;

  own: {
    board: ServerBoard; // tablero propio completo (naves, escudos, humo)
    publicMarks: PublicBoardState; // cómo lo ven los demás
    energy: number;
    hand: CardId[];
    deckCount: number;
  };

  /** Un tablero por rival. Nunca contiene posiciones de naves no hundidas. */
  opponents: Record<PlayerId, OpponentBoardView>;

  seq: number;
  serverTime: number;
}

/**
 * Proyección: ServerRoomState + id del observador → GameView.
 *   opponents[x].public  = state.publicBoards[x]
 *   opponents[x].private = state.knowledge[viewerId][x]   (solo la del observador)
 * Se implementa en el servidor; el cliente nunca recibe ServerRoomState.
 */
export type ProjectView = (state: ServerRoomState, viewerId: PlayerId, now: number) => GameView;
