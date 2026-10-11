const SDK_URL = 'https://www.gstatic.com/firebasejs/11.10.0';
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const QUEUE_TTL_MS = 180000;

function makeRoomCode(){
  const values = new Uint8Array(6);
  crypto.getRandomValues(values);
  return Array.from(values, value => ROOM_ALPHABET[value % ROOM_ALPHABET.length]).join('');
}

export async function connectFirebaseOnline(config, handlers){
  if (!config || !config.apiKey || config.apiKey.startsWith('PEGA_AQUI') || !config.databaseURL) {
    throw new Error('Falta configurar Firebase: revisa firebase-config.js.');
  }

  const [appSdk, authSdk, databaseSdk] = await Promise.all([
    import(`${SDK_URL}/firebase-app.js`),
    import(`${SDK_URL}/firebase-auth.js`),
    import(`${SDK_URL}/firebase-database.js`)
  ]);

  const appName = 'mass-brawl-online';
  const app = appSdk.getApps().find(existing => existing.name === appName)
    || appSdk.initializeApp(config, appName);
  const auth = authSdk.getAuth(app);
  const database = databaseSdk.getDatabase(app);
  await authSdk.setPersistence(auth, authSdk.browserSessionPersistence);
  const credential = auth.currentUser
    ? { user: auth.currentUser }
    : await authSdk.signInAnonymously(auth);
  const uid = credential.user.uid;

  let roomRef = null;
  let roomCode = null;
  let role = null;
  let unsubscribeRoom = null;
  let matchStarted = false;
  let activatingRoom = false;

  const queueRef = databaseSdk.ref(database, 'matchmaking/waiting');

  function reportError(error){
    handlers.onError(error);
  }

  async function clearQueue(){
    await databaseSdk.runTransaction(queueRef, current => {
      return current && current.uid === uid ? null : undefined;
    });
  }

  function detachRoom(){
    if (unsubscribeRoom) unsubscribeRoom();
    unsubscribeRoom = null;
    roomRef = null;
    roomCode = null;
    role = null;
    matchStarted = false;
    activatingRoom = false;
  }

  function listenToRoom(code, assignedRole){
    detachRoom();
    roomCode = code;
    role = assignedRole;
    roomRef = databaseSdk.ref(database, `rooms/${code}`);
    const activeRoomRef = roomRef;

    unsubscribeRoom = databaseSdk.onValue(activeRoomRef, async snapshot => {
      const room = snapshot.val();
      if (!room) {
        handlers.onRoomStatus('missing');
        return;
      }

      handlers.onRoomStatus(room.status);
      const hasPlayers = Boolean(room.players?.blue && room.players?.orange);
      if (room.status === 'waiting' && hasPlayers && role === 'blue' && !activatingRoom) {
        activatingRoom = true;
        try {
          const result = await databaseSdk.runTransaction(activeRoomRef, current => {
            if (!current || current.status !== 'waiting' || !current.players?.orange) return;
            return { ...current, status: 'playing' };
          });
          if (!result.committed) activatingRoom = false;
        } catch (error) {
          activatingRoom = false;
          reportError(error);
        }
        return;
      }

      if (room.status !== 'playing' || !hasPlayers) return;
      if (!matchStarted) {
        matchStarted = true;
        handlers.onMatched({ roomCode: code, role });
        clearQueue().catch(reportError);
      }

      const game = room.game;
      if (game && Number.isSafeInteger(game.revision) && game.updatedBy !== uid) {
        handlers.onGameState(game);
      }
    }, reportError);

    handlers.onRoomStatus('waiting');
  }

  async function createRoom(){
    await clearQueue();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = makeRoomCode();
      const newRoomRef = databaseSdk.ref(database, `rooms/${code}`);
      const result = await databaseSdk.runTransaction(newRoomRef, current => {
        if (current !== null) return;
        return {
          status: 'waiting',
          createdAt: Date.now(),
          players: { blue: uid, orange: null },
          game: null
        };
      });
      if (result.committed) {
        listenToRoom(code, 'blue');
        return code;
      }
    }
    throw new Error('No se pudo reservar un código de sala. Inténtalo de nuevo.');
  }

  async function joinRoom(code){
    const normalizedCode = String(code).toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(normalizedCode)) {
      throw new Error('El código debe tener seis caracteres válidos.');
    }
    await clearQueue();
    const targetRef = databaseSdk.ref(database, `rooms/${normalizedCode}`);
    const roomSnapshot = await databaseSdk.get(targetRef);
    const currentRoom = roomSnapshot.val();
    if (!currentRoom) {
      throw new Error('No existe ninguna sala con ese código. Comprueba que el código sea el actual.');
    }
    if (currentRoom.players?.blue === uid) {
      throw new Error('No puedes entrar en una sala creada desde esta misma sesión. Usa otra sesión del navegador o un dispositivo distinto.');
    }
    if (currentRoom.status !== 'waiting' || currentRoom.players?.orange) {
      throw new Error('La sala ya está completa o la partida ya ha comenzado.');
    }

    const orangePlayerRef = databaseSdk.ref(database, `rooms/${normalizedCode}/players/orange`);
    const result = await databaseSdk.runTransaction(orangePlayerRef, current => {
      if (current === null) return uid;
      return current === uid ? current : undefined;
    });
    if (!result.committed && result.snapshot.val() !== uid) {
      const latestRoomSnapshot = await databaseSdk.get(targetRef);
      const latestRoom = latestRoomSnapshot.val();
      if (latestRoom?.players?.orange === uid) {
        listenToRoom(normalizedCode, 'orange');
        return normalizedCode;
      }
      if (!latestRoom) {
        throw new Error('La sala ya no se encuentra en Firebase. Comprueba que ambos clientes usan el mismo proyecto y la misma URL de Realtime Database.');
      }
      if (latestRoom.players?.blue === uid) {
        throw new Error('Firebase está usando la misma sesión para ambos jugadores. Actualiza el juego y prueba con otra sesión del navegador.');
      }
      if (latestRoom.status !== 'waiting' || latestRoom.players?.orange) {
        throw new Error('La sala ya está completa o la partida ya ha comenzado.');
      }
      throw new Error('No se pudo entrar en la sala. Comprueba las reglas de Realtime Database y vuelve a intentarlo.');
    }
    listenToRoom(normalizedCode, 'orange');
    return normalizedCode;
  }

  async function findRandomMatch(){
    const ownRoomCode = await createRoom();
    const queuedSnapshot = await databaseSdk.get(queueRef);
    let candidate = queuedSnapshot.val();

    if (!candidate || candidate.uid === uid || Date.now() - candidate.createdAt >= QUEUE_TTL_MS) {
      const result = await databaseSdk.runTransaction(queueRef, current => {
        if (current && current.uid !== uid && Date.now() - current.createdAt < QUEUE_TTL_MS) return;
        return { uid, roomCode: ownRoomCode, createdAt: Date.now() };
      });
      if (result.committed) return { waiting: true, roomCode: ownRoomCode };

      const latestQueueSnapshot = await databaseSdk.get(queueRef);
      candidate = latestQueueSnapshot.val();
      if (candidate?.uid === uid) return { waiting: true, roomCode: ownRoomCode };
    }

    if (candidate?.uid === uid) {
      return { waiting: true, roomCode: ownRoomCode };
    }
    if (!candidate?.roomCode || Date.now() - candidate.createdAt >= QUEUE_TTL_MS) {
      throw new Error('No se pudo leer un rival disponible en la cola. Inténtalo de nuevo.');
    }

    detachRoom();
    await databaseSdk.remove(databaseSdk.ref(database, `rooms/${ownRoomCode}`));
    try {
      await joinRoom(candidate.roomCode);
    } catch (error) {
      throw new Error(`Se encontró una búsqueda, pero no se pudo entrar en su sala: ${error.message || String(error)}`);
    }
    return { waiting: false, roomCode: candidate.roomCode };
  }

  async function publishGameState(state){
    if (!roomRef || !role) throw new Error('No hay una sala online activa.');
    const currentRoomRef = roomRef;
    const currentCode = roomCode;
    const result = await databaseSdk.runTransaction(
      databaseSdk.ref(database, `rooms/${currentCode}/game`),
      current => ({
        ...state,
        revision: (Number.isSafeInteger(current?.revision) ? current.revision : 0) + 1,
        updatedBy: uid
      })
    );
    if (!result.committed) throw new Error('No se pudo sincronizar la jugada.');
    if (roomRef !== currentRoomRef) return;
  }

  async function leave(){
    const leavingRef = roomRef;
    const leavingRole = role;
    detachRoom();
    try {
      await clearQueue();
      if (leavingRef && leavingRole) {
        await databaseSdk.runTransaction(leavingRef, current => {
          if (!current) return;
          return { ...current, status: 'finished' };
        });
      }
    } catch (error) {
      reportError(error);
    }
  }

  return { createRoom, joinRoom, findRandomMatch, publishGameState, leave };
}
