import { createRoom as engineCreateRoom } from '../../core/engine';
import { projectView } from '../../core/view';

function createRandomBoardWithShips() {
  const size = 10;
  const cells: any[][] = [];
  for (let r = 0; r < size; r++) {
    const row: any[] = [];
    for (let c = 0; c < size; c++) {
      row.push({ shipId: null, hit: false });
    }
    cells.push(row);
  }

  const shipConfigs = [
    { id: 'carrier', name: 'Portaaviones', length: 4 },
    { id: 'battleship', name: 'Acorazado', length: 3 },
    { id: 'cruiser', name: 'Crucero', length: 2 },
    { id: 'destroyer', name: 'Destructor', length: 1 }
  ];

  const ships: any[] = [];

  shipConfigs.forEach(cfg => {
    let placed = false;
    let attempts = 0;

    while (!placed && attempts < 100) {
      attempts++;
      const horizontal = Math.random() < 0.5;
      const r = Math.floor(Math.random() * (horizontal ? size : size - cfg.length + 1));
      const c = Math.floor(Math.random() * (horizontal ? size - cfg.length + 1 : size));

      let canPlace = true;
      const coords: { r: number; c: number }[] = [];

      for (let i = 0; i < cfg.length; i++) {
        const currR = horizontal ? r : r + i;
        const currC = horizontal ? c + i : c;

        if (cells[currR][currC].shipId !== null) {
          canPlace = false;
          break;
        }
        coords.push({ r: currR, c: currC });
      }

      if (canPlace) {
        coords.forEach(coord => {
          cells[coord.r][coord.c].shipId = cfg.id;
        });

        ships.push({
          id: cfg.id,
          name: cfg.name,
          length: cfg.length,
          coords: coords,
          hits: 0,
          sunk: false,
          isHorizontal: horizontal
        });

        placed = true;
      }
    }
  });

  return { ships, grid: cells, cells };
}

export class RoomManager {
  private rooms: Map<string, any> = new Map();

  generateRoomCode(): string {
    return Math.floor(1000 + Math.random() * 9000).toString();
  }

  createRoom(hostSocketId: string, hostName: string): { roomCode: string; roomState: any } {
    const roomCode = this.generateRoomCode();
    const now = Date.now();

    const engineResult = engineCreateRoom({
      roomId: roomCode,
      code: roomCode,
      now: now,
      host: { id: hostSocketId, name: hostName || 'Jugador 1' },
      config: { humansSlots: 1, botLevel: 'easy' }
    } as any);

    let engineState = (engineResult as any)?.state || engineResult;

    if (!engineState) {
      engineState = { roomId: roomCode, players: [], phase: 'setup' };
    }

    if (!engineState.players) engineState.players = [];

    if (!engineState.players.some((p: any) => p.id === hostSocketId)) {
      engineState.players.unshift({
        id: hostSocketId,
        name: hostName || 'Tú',
        isBot: false,
        status: 'active',
        ready: false,
        fleetConfirmed: false,
        board: null,
        energy: 10
      });
    }

    while (engineState.players.length < 4) {
      const botIdx = engineState.players.length;
      const botId = `bot-${botIdx}`;
      engineState.players.push({
        id: botId,
        name: `CPU ${botIdx}`,
        isBot: true,
        status: 'active',
        ready: true,
        fleetConfirmed: true,
        board: createRandomBoardWithShips(),
        energy: 10
      });
    }

    engineState.phase = 'setup';
    if (!engineState.publicBoards) engineState.publicBoards = {};
    if (!engineState.shields) engineState.shields = {};

    engineState.players.forEach((p: any) => {
      if (!engineState.publicBoards[p.id]) {
        engineState.publicBoards[p.id] = { marks: [] };
      }
      if (!engineState.shields[p.id]) {
        engineState.shields[p.id] = [];
      }
    });

    const roomState = { roomId: roomCode, engineState };
    this.rooms.set(roomCode, roomState);
    return { roomCode, roomState };
  }

  confirmPlayerFleet(roomCode: string, playerId: string, ships: any[], grid: any[][]) {
    const room = this.rooms.get(roomCode);
    if (!room || !room.engineState) return;

    const state = room.engineState;
    const player = state.players.find((p: any) => p.id === playerId);

    if (player) {
      const cells = grid.map(row => row.map(cell => ({
        shipId: cell,
        hit: false
      })));

      player.board = { ships, grid: cells, cells };
      player.fleetConfirmed = true;
      player.ready = true;
    }

    state.phase = 'playing';
  }

  spinRoulette(roomCode: string, playerId: string): { targetId: string | null; targetName: string; isFreeChoice: boolean } | null {
    const room = this.rooms.get(roomCode);
    if (!room || !room.engineState) return null;

    const state = room.engineState;
    const activePlayers = state.players.filter((p: any) => p.status === 'active');
    if (activePlayers.length === 0) return null;

    const selected = activePlayers[Math.floor(Math.random() * activePlayers.length)];
    const isFreeChoice = selected.id === playerId;

    if (!state.turn) state.turn = {};
    state.turn.targetPlayerId = isFreeChoice ? null : selected.id;

    return {
      targetId: selected.id,
      targetName: selected.name,
      isFreeChoice
    };
  }

  getRoom(roomCode: string): any {
    return this.rooms.get(roomCode);
  }

  getPlayerView(roomCode: string, targetId: string): any {
    const room = this.rooms.get(roomCode);
    if (!room || !room.engineState) return null;

    const state = room.engineState;
    let view: any = null;

    try {
      view = (projectView as any)(state, targetId);
    } catch (e) {
      console.warn("⚠️ Copia directa de vista.");
    }

    if (!view) {
      view = JSON.parse(JSON.stringify(state));
    }

    if (view.players) {
      view.players.forEach((p: any) => {
        if (p.id === targetId) {
          const originalPlayer = state.players.find((op: any) => op.id === targetId);
          if (originalPlayer && originalPlayer.board) {
            p.board = originalPlayer.board;
          }
        }
      });
    }

    view.publicBoards = state.publicBoards;
    view.shields = state.shields;
    return view;
  }

  registerShotMark(state: any, attackerId: string, targetId: string, coord: { r: number; c: number }) {
    const targetPlayer = state.players.find((p: any) => p.id === targetId);
    const attacker = state.players.find((p: any) => p.id === attackerId);
    if (!targetPlayer || !targetPlayer.board) return;

    // ABSORCIÓN DE DISPARO POR ESCUDO EN CASILLA ESPECÍFICA (DURA HASTA QUE RECIBE UN DISPARO)
    if (state.shields && state.shields[targetId]) {
      const shieldIndex = state.shields[targetId].findIndex((s: any) => s.r === coord.r && s.c === coord.c);
      if (shieldIndex !== -1) {
        state.shields[targetId].splice(shieldIndex, 1); // Se consume el escudo de esta casilla
        console.log(`🛡️ ¡Impacto absorbido en casilla (${coord.r}, ${coord.c}) por Escudo de ${targetPlayer.name}! Escudo destruido.`);
        return;
      }
    }

    if (!state.publicBoards[targetId]) {
      state.publicBoards[targetId] = { marks: [] };
    }

    const publicMarks = state.publicBoards[targetId].marks;
    const alreadyMarked = publicMarks.some((m: any) => {
      const c = m.coord || m.at;
      return c && c.r === coord.r && c.c === coord.c;
    });

    if (!alreadyMarked) {
      const cell = targetPlayer.board.cells[coord.r][coord.c];
      const isHit = cell && cell.shipId !== null;

      publicMarks.push({
        kind: isHit ? 'hit' : 'miss',
        coord: coord,
        at: coord
      });

      if (isHit && attacker) {
        attacker.energy = Math.min(10, (attacker.energy || 0) + 1);
      }
    }

    this.checkSunkShips(state, attackerId, targetId);
  }

  checkSunkShips(state: any, attackerId: string, targetId: string) {
    const targetPlayer = state.players.find((p: any) => p.id === targetId);
    const attacker = state.players.find((p: any) => p.id === attackerId);

    if (targetPlayer && targetPlayer.board && targetPlayer.board.ships) {
      targetPlayer.board.ships.forEach((ship: any) => {
        if (!ship.sunk) {
          const hitsOnShip = ship.coords.filter((c: any) => {
            const marks = state.publicBoards[targetId]?.marks || [];
            return marks.some((m: any) => {
              const coord = m.coord || m.at;
              return coord && coord.r === c.r && coord.c === c.c && (m.kind === 'hit' || m.kind === 'sunk');
            });
          }).length;

          if (hitsOnShip >= ship.length) {
            ship.sunk = true;

            if (attacker) {
              attacker.energy = Math.min(10, (attacker.energy || 0) + 3);
            }

            const publicMarks = state.publicBoards[targetId]?.marks;
            if (publicMarks) {
              ship.coords.forEach((c: any) => {
                const mark = publicMarks.find((m: any) => {
                  const coord = m.coord || m.at;
                  return coord && coord.r === c.r && coord.c === c.c;
                });
                if (mark) mark.kind = 'sunk';
              });
            }
          }
        }
      });
    }
  }

  async processBotTurns(roomCode: string, humanPlayerId: string, ioServer?: any) {
    const room = this.rooms.get(roomCode);
    if (!room || !room.engineState) return;

    const state = room.engineState;
    // (SE REMOVIÓ LA LIMPIEZA AUTOMÁTICA DE ESCUDOS POR RONDA: AHORA PERMANECEN HASTA SER IMPACTADOS)

    const bots = state.players.filter((p: any) => p.isBot && p.status === 'active');

    for (const bot of bots) {
      await new Promise((resolve) => setTimeout(resolve, 350));

      const otherPlayers = state.players.filter((p: any) => p.id !== bot.id && p.status === 'active');
      if (otherPlayers.length === 0) continue;

      const target = otherPlayers[Math.floor(Math.random() * otherPlayers.length)];
      const targetMarks = state.publicBoards[target.id]?.marks || [];
      const availableCoords: { r: number; c: number }[] = [];

      for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 10; c++) {
          const alreadyShot = targetMarks.some((m: any) => {
            const coord = m.coord || m.at;
            return coord && coord.r === r && coord.c === c;
          });
          if (!alreadyShot) availableCoords.push({ r, c });
        }
      }

      if (availableCoords.length > 0) {
        const randomCoord = availableCoords[Math.floor(Math.random() * availableCoords.length)];
        this.registerShotMark(state, bot.id, target.id, randomCoord);

        if (ioServer) {
          const view = this.getPlayerView(roomCode, humanPlayerId);
          ioServer.to(roomCode).emit('game:state', view || state);
        }
      }
    }
  }

  async applyAction(roomCode: string, action: any, humanPlayerId: string, ioServer?: any): Promise<any> {
    const room = this.rooms.get(roomCode);
    if (!room || !room.engineState) return null;

    const state = room.engineState;
    const player = state.players.find((p: any) => p.id === humanPlayerId);
    if (!player) return null;

    const costs: Record<string, number> = {
      'basic_shot': 0,
      'cross_shot': 4,
      'sonar': 2,
      'rain': 6,
      'shield': 2,
      'move_ship': 2,
      'repair': 3
    };

    const cost = costs[action.kind] || 0;
    if (player.energy < cost) {
      return null;
    }

    if (action.kind === 'shield' || action.kind === 'repair') {
      const publicMarks = state.publicBoards[humanPlayerId]?.marks || [];
      const isSunk = publicMarks.some((m: any) => {
        const c = m.coord || m.at;
        return c && c.r === action.at.r && c.c === action.at.c && m.kind === 'sunk';
      });

      if (isSunk) {
        if (ioServer) {
          ioServer.to(humanPlayerId).emit('game:error', {
            message: 'Movimiento no válido: El barco ya está hundido.'
          });
        }
        return { ok: false };
      }
    }

    player.energy -= cost;

    if (action.kind === 'shield' && action.at) {
      if (!state.shields[humanPlayerId]) state.shields[humanPlayerId] = [];
      // Agregar escudo únicamente a la casilla seleccionada
      state.shields[humanPlayerId].push(action.at);
      this.processBotTurns(roomCode, humanPlayerId, ioServer);
    }
    else if (action.kind === 'repair' && action.at) {
      const publicMarks = state.publicBoards[humanPlayerId]?.marks || [];
      const markIndex = publicMarks.findIndex((m: any) => {
        const c = m.coord || m.at;
        return c && c.r === action.at.r && c.c === action.at.c && m.kind === 'hit';
      });

      if (markIndex !== -1) {
        publicMarks.splice(markIndex, 1);
        console.log(`🔧 ¡Casilla (${action.at.r}, ${action.at.c}) reparada con éxito!`);
      }
      this.processBotTurns(roomCode, humanPlayerId, ioServer);
    }
    else if (action.kind === 'move_ship' && action.shipId && action.to) {
      if (player.board && player.board.ships) {
        const ship = player.board.ships.find((s: any) => s.id === action.shipId);
        if (ship && !ship.sunk) {
          const isHoriz = action.isHorizontal !== undefined ? action.isHorizontal : (ship.isHorizontal ?? true);

          const newCoords: { r: number; c: number }[] = [];
          let isValidPlacement = true;

          for (let i = 0; i < ship.length; i++) {
            const r = isHoriz ? action.to.r : action.to.r + i;
            const c = isHoriz ? action.to.c + i : action.to.c;

            if (r < 0 || r >= 10 || c < 0 || c >= 10) {
              isValidPlacement = false;
              break;
            }

            const existingShipId = player.board.cells[r][c].shipId;
            if (existingShipId !== null && existingShipId !== ship.id) {
              isValidPlacement = false;
              break;
            }

            newCoords.push({ r, c });
          }

          if (!isValidPlacement || newCoords.length !== ship.length) {
            player.energy += cost;
            if (ioServer) {
              ioServer.to(humanPlayerId).emit('game:error', {
                message: 'Movimiento no válido: El barco no entra en esa posición'
              });
            }
            return { ok: false };
          }

          if (ship.coords) {
            ship.coords.forEach((c: any) => {
              if (player.board.cells[c.r] && player.board.cells[c.r][c.c]) {
                player.board.cells[c.r][c.c].shipId = null;
              }
            });
          }

          ship.coords = newCoords;
          ship.isHorizontal = isHoriz;
          newCoords.forEach(c => {
            player.board.cells[c.r][c.c].shipId = ship.id;
          });
          console.log(`⚓ Barco ${ship.name} reubicado exitosamente.`);
        }
      }
      this.processBotTurns(roomCode, humanPlayerId, ioServer);
    }
    else if (action.kind === 'sonar' && action.targetId && action.at) {
      const targetPlayer = state.players.find((p: any) => p.id === action.targetId);
      const cellsResult: { r: number; c: number; isShip: boolean }[] = [];
      let foundCount = 0;

      if (targetPlayer && targetPlayer.board) {
        const center = action.at;
        for (let dr = 0; dr <= 1; dr++) {
          for (let dc = 0; dc <= 1; dc++) {
            const r = center.r + dr;
            const c = center.c + dc;
            if (r >= 0 && r < 10 && c >= 0 && c < 10) {
              const cell = targetPlayer.board.cells[r][c];
              const isShip = cell && cell.shipId !== null;
              if (isShip) foundCount++;
              cellsResult.push({ r, c, isShip });
            }
          }
        }
      }

      if (ioServer) {
        ioServer.to(roomCode).emit('game:sonar_result', {
          targetId: action.targetId,
          targetName: targetPlayer?.name || action.targetId,
          cells: cellsResult,
          foundCount
        });
      }

      this.processBotTurns(roomCode, humanPlayerId, ioServer);
    }
    else if (action.kind === 'cross_shot' && action.targetId && action.at) {
      const center = action.at;
      const coordsToHit = [
        center,
        { r: center.r - 1, c: center.c },
        { r: center.r + 1, c: center.c },
        { r: center.r, c: center.c - 1 },
        { r: center.r, c: center.c + 1 }
      ];
      coordsToHit.forEach(coord => {
        if (coord.r >= 0 && coord.r < 10 && coord.c >= 0 && coord.c < 10) {
          this.registerShotMark(state, humanPlayerId, action.targetId, coord);
        }
      });
      this.processBotTurns(roomCode, humanPlayerId, ioServer);
    }
    else if (action.kind === 'rain' && action.targetId) {
      for (let i = 0; i < 6; i++) {
        const randR = Math.floor(Math.random() * 10);
        const randC = Math.floor(Math.random() * 10);
        this.registerShotMark(state, humanPlayerId, action.targetId, { r: randR, c: randC });
      }
      this.processBotTurns(roomCode, humanPlayerId, ioServer);
    }
    else if (action.kind === 'basic_shot' && action.targetId && action.at) {
      this.registerShotMark(state, humanPlayerId, action.targetId, action.at);
      this.processBotTurns(roomCode, humanPlayerId, ioServer);
    }

    room.engineState = state;
    return { ok: true, state };
  }
}

export const roomManager = new RoomManager();