/**
 * Batalla Naval 4J — Contrato de eventos Socket.io
 *
 * Uso en el servidor (Node.js):
 *   import { Server } from 'socket.io';
 *   const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(httpServer, {
 *     pingInterval: 10_000,
 *     pingTimeout: 10_000,
 *   });
 *
 * Reglas del contrato:
 *  - El cliente solo envía INTENCIONES; el servidor valida y resuelve todo.
 *  - Toda respuesta a una intención va por ack (aceptada/rechazada); el RESULTADO llega por eventos.
 *  - Cada evento del servidor lleva seq (monotónico por sala). Si el cliente ve un salto → 'state:resync'.
 *  - turn:act es idempotente por (turnId, actionId).
 */
import type {
  ActionId,
  BotLevel,
  ConnectionState,
  GameView,
  OwnBoardPatch,
  PlayerId,
  PlayerStatus,
  PrivateActionResult,
  PublicActionResult,
  RoomConfig,
  RoomId,
  RoomPhase,
  Ship,
  ShipPlacement,
  TurnAction,
  TurnId,
  TurnState,
  CardId,
} from './types';

// ───────────────────────── Ack y errores ─────────────────────────
export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ALREADY_IN_ROOM'
  | 'INVALID_PHASE'
  | 'NOT_YOUR_TURN'
  | 'STALE_TURN'
  | 'DUPLICATE_ACTION'
  | 'INVALID_TARGET' // no coincide con la ruleta / jugador eliminado
  | 'INVALID_COORD'
  | 'INVALID_PARAMS'
  | 'CARD_NOT_IN_HAND'
  | 'INSUFFICIENT_ENERGY'
  | 'INVALID_PLACEMENT'
  | 'INTERNAL';

export type Ack<T = void> = { ok: true; data: T } | { ok: false; error: ErrorCode; message: string };
export type AckFn<T = void> = (res: Ack<T>) => void;

// ───────────────────────── Metadatos comunes ─────────────────────────
export interface EventMeta {
  roomId: RoomId;
  /** Contador monotónico de la sala. */
  seq: number;
  /** Epoch ms del servidor, para que el cliente corrija el desfase de su reloj. */
  serverTime: number;
}

export interface LobbyPlayer {
  id: PlayerId;
  displayName: string;
  isBot: boolean;
  /** En lobby: listo para empezar. En colocación: flota confirmada. */
  ready: boolean;
  connection: ConnectionState;
}

export interface LobbyView {
  roomId: RoomId;
  code: string;
  phase: RoomPhase;
  hostId: PlayerId;
  capacity: 4;
  config: RoomConfig;
  players: LobbyPlayer[];
}

export interface SessionInfo {
  roomId: RoomId;
  code: string;
  playerId: PlayerId;
  /** Guardar en el dispositivo: permite reconectar tras perder señal o cerrar la app. */
  reconnectToken: string;
}

// ───────────────────────── Cliente → Servidor ─────────────────────────
export interface ClientToServerEvents {
  // Sesión
  'session:resume': (p: { reconnectToken: string }, ack: AckFn<{ view: GameView | null; lobby: LobbyView | null }>) => void;

  // Lobby
  'lobby:create': (
    p: { displayName: string; isPrivate: boolean; humanSlots: RoomConfig['humanSlots']; botLevel: BotLevel },
    ack: AckFn<SessionInfo>,
  ) => void;
  /** Solo el anfitrión, en lobby: cuántos humanos y qué dificultad de bots. */
  'lobby:configure': (p: RoomConfig, ack: AckFn) => void;
  /** Solo el anfitrión: los lugares sin humano se llenan con bots y pasa a colocación. */
  'lobby:start': (ack: AckFn) => void;
  'lobby:join': (p: { code: string; displayName: string }, ack: AckFn<SessionInfo>) => void;
  'lobby:quickmatch': (p: { displayName: string }, ack: AckFn<SessionInfo>) => void;
  'lobby:ready': (p: { ready: boolean }, ack: AckFn) => void;
  'lobby:leave': (ack: AckFn) => void;

  // Colocación de flota (el servidor valida límites, solapes y las 6 naves)
  'fleet:place': (p: { placements: ShipPlacement[] }, ack: AckFn) => void;
  'fleet:randomize': (ack: AckFn<{ placements: ShipPlacement[] }>) => void;
  'fleet:confirm': (ack: AckFn) => void;

  // Turno: carta O disparo básico. Una sola acción por turno.
  'turn:act': (p: { turnId: TurnId; actionId: ActionId; action: TurnAction }, ack: AckFn<{ accepted: true }>) => void;

  // Re-sincronización completa (huecos de seq, vuelta de segundo plano)
  'state:resync': (p: { lastSeq: number }, ack: AckFn<{ view: GameView }>) => void;
}

// ───────────────────────── Servidor → Cliente ─────────────────────────
export interface ServerToClientEvents {
  'lobby:update': (p: EventMeta & { lobby: LobbyView }) => void;

  'placement:started': (p: EventMeta & { deadline: number }) => void;

  /** Primera vista proyectada al comenzar la fase de juego. */
  'game:started': (p: EventMeta & { view: GameView }) => void;

  'turn:started': (p: EventMeta & { turn: TurnState }) => void;

  /**
   * El servidor ya decidió el resultado (crypto RNG); el giro es solo animación.
   * Todos los clientes terminan la animación en animateEndAt (hora del servidor).
   */
  'roulette:result': (
    p: EventMeta & {
      turnId: TurnId;
      sectors: PlayerId[];
      resultSector: number;
      landedOn: PlayerId;
      freeChoice: boolean;
      animateEndAt: number;
    },
  ) => void;

  /** A los 4: {atacante, objetivo, cartaJugada} + coordenadas solo de impactos. */
  'action:public': (p: EventMeta & { result: PublicActionResult }) => void;

  /** Solo al actor: marcas privadas nuevas (Agua, reconocimiento) y economía. */
  'action:private': (p: EventMeta & { result: PrivateActionResult }) => void;

  /** Solo al dueño del tablero afectado. */
  'own:update': (p: EventMeta & { patch: OwnBoardPatch }) => void;

  /** Solo al jugador: energía y mano al empezar su turno (robo, +energía por turno). */
  'own:resources': (p: EventMeta & { energy: number; hand: CardId[]; deckCount: number }) => void;

  'player:status': (
    p: EventMeta & {
      playerId: PlayerId;
      status: PlayerStatus;
      connection: ConnectionState;
      reason?: 'disconnected' | 'reconnected' | 'all_ships_sunk' | 'forfeit_timeout' | 'left';
    },
  ) => void;

  'game:over': (
    p: EventMeta & {
      winnerId: PlayerId | null;
      reason: 'last_standing' | 'forfeit';
      ranking: PlayerId[];
      /** Al terminar se revelan todas las flotas. */
      finalBoards: Record<PlayerId, Ship[]>;
    },
  ) => void;

  /** Respuesta a huecos de seq o a session:resume sin ack. */
  'state:snapshot': (p: EventMeta & { view: GameView }) => void;
}

export type InterServerEvents = Record<string, never>;

export interface SocketData {
  playerId?: PlayerId;
  roomId?: RoomId;
}
