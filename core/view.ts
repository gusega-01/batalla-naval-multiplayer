/**
 * projectView: ServerRoomState → GameView para UN jugador.
 * Es la ÚNICA puerta por la que sale información del servidor hacia un cliente (o hacia un bot).
 *
 *   own        → tablero propio completo + energía + mano
 *   opponents  → por rival: capa pública (Tocado/Hundido) + SU capa privada knowledge[viewer][rival]
 *
 * Nunca incluye: posiciones de naves rivales, energía/mano rival (solo el tamaño), mazos, tokens, semilla.
 */
import { deepClone } from './util';
import type { GameView, OpponentBoardView, PlayerId, PublicBoardState, ServerRoomState } from './types';

const emptyPublic = (ownerId: PlayerId): PublicBoardState => ({ ownerId, marks: [], sunkShips: [] });

export function projectView(state: ServerRoomState, viewerId: PlayerId, now: number): GameView {
  const me = state.players.find((p) => p.id === viewerId);
  if (!me) throw new Error(`Jugador desconocido: ${viewerId}`);

  const opponents: Record<PlayerId, OpponentBoardView> = {};
  for (const p of state.players) {
    if (p.id === viewerId) continue;
    opponents[p.id] = {
      ownerId: p.id,
      public: state.publicBoards[p.id] ?? emptyPublic(p.id),
      private: state.knowledge[viewerId]?.[p.id] ?? { cellMarks: {}, notes: [] },
    };
  }

  const view: GameView = {
    roomId: state.roomId,
    phase: state.phase,
    round: state.round,
    you: viewerId,
    players: state.players.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      seat: p.seat,
      isBot: p.isBot,
      status: p.status,
      connection: p.connection,
      handSize: p.hand.length,
      shipsRemaining: p.board.ships.filter((s) => !s.sunk).length,
    })),
    turn: state.turn,
    own: {
      board: me.board,
      publicMarks: state.publicBoards[viewerId] ?? emptyPublic(viewerId),
      energy: me.energy,
      hand: me.hand,
      deckCount: me.deck.length,
    },
    opponents,
    seq: state.seq,
    serverTime: now,
  };
  // Clon: el consumidor (UI, bot, socket) nunca queda con referencias al estado vivo.
  return deepClone(view);
}
