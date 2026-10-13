const SDK_URL = 'https://www.gstatic.com/firebasejs/11.10.0';
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const QUEUE_TTL_MS = 180000;

function getMessage(handlers, key, values = {}){
  const translated = handlers.translate ? handlers.translate(key) : key;
  return Object.entries(values).reduce(
    (message, [name, value]) => message.split(`{${name}}`).join(String(value)),
    translated
  );
}

function makeRoomCode(){
  const values = new Uint8Array(6);
  crypto.getRandomValues(values);
  return Array.from(values, value => ROOM_ALPHABET[value % ROOM_ALPHABET.length]).join('');
}

export async function connectFirebaseOnline(config, handlers){
  if (!config || !config.apiKey || config.apiKey.startsWith('PEGA_AQUI') || !config.databaseURL) {
    throw new Error(getMessage(handlers, 'firebaseConfigMissing'));
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
  let unsubscribeConnection = null;
  let matchStarted = false;
  let activatingRoom = false;
  let presenceRef = null;
  let presenceGeneration = 0;
  let lastOpponentPresence = null;

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
    presenceGeneration += 1;
    if (unsubscribeRoom) unsubscribeRoom();
    if (unsubscribeConnection) unsubscribeConnection();
    unsubscribeRoom = null;
    unsubscribeConnection = null;
    if (presenceRef) {
      databaseSdk.onDisconnect(presenceRef).cancel().catch(reportError);
    }
    presenceRef = null;
    roomRef = null;
    roomCode = null;
    role = null;
    matchStarted = false;
    activatingRoom = false;
    lastOpponentPresence = null;
  }

  function listenToRoom(code, assignedRole){
    detachRoom();
    roomCode = code;
    role = assignedRole;
    roomRef = databaseSdk.ref(database, `rooms/${code}`);
    const activeRoomRef = roomRef;
    const activePresenceGeneration = presenceGeneration;
    const playerPresenceRef = databaseSdk.ref(database, `rooms/${code}/presence/${assignedRole}/${uid}`);
    presenceRef = playerPresenceRef;
    const connectedRef = databaseSdk.ref(database, '.info/connected');

    unsubscribeConnection = databaseSdk.onValue(connectedRef, async snapshot => {
      if (activePresenceGeneration !== presenceGeneration) return;
      if (snapshot.val() !== true) {
        if (snapshot.val() === false) handlers.onConnection(false);
        return;
      }
      try {
        await databaseSdk.onDisconnect(playerPresenceRef).set(false);
        if (activePresenceGeneration !== presenceGeneration) {
          await databaseSdk.onDisconnect(playerPresenceRef).cancel();
          return;
        }
        await databaseSdk.set(playerPresenceRef, true);
        handlers.onConnection(true);
      } catch (error) {
        reportError(error);
      }
    }, reportError);

    unsubscribeRoom = databaseSdk.onValue(activeRoomRef, async snapshot => {
      const room = snapshot.val();
      if (!room) {
        handlers.onRoomStatus('missing');
        return;
      }

      handlers.onRoomStatus(room.status, Boolean(room.result));
      if (room.result) handlers.onMatchResult(room.result);
      const hasPlayers = Boolean(room.players?.blue && room.players?.orange);
      const opponentRole = assignedRole === 'blue' ? 'orange' : 'blue';
      const opponentUid = room.players?.[opponentRole];
      const opponentPresence = opponentUid ? room.presence?.[opponentRole]?.[opponentUid] : undefined;

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

      if (typeof opponentPresence === 'boolean' && opponentPresence !== lastOpponentPresence) {
        lastOpponentPresence = opponentPresence;
        handlers.onOpponentPresence(opponentPresence);
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
    throw new Error(getMessage(handlers, 'roomCreateFailed'));
  }

  async function joinRoom(code){
    const normalizedCode = String(code).toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(normalizedCode)) {
      throw new Error(getMessage(handlers, 'invalidRoomCode'));
    }
    await clearQueue();
    const targetRef = databaseSdk.ref(database, `rooms/${normalizedCode}`);
    const roomSnapshot = await databaseSdk.get(targetRef);
    const currentRoom = roomSnapshot.val();
    if (!currentRoom) {
      throw new Error(getMessage(handlers, 'roomNotFound'));
    }
    if (currentRoom.players?.blue === uid) {
      throw new Error(getMessage(handlers, 'sameSessionRoom'));
    }
    if (currentRoom.status !== 'waiting' || currentRoom.players?.orange) {
      throw new Error(getMessage(handlers, 'roomFull'));
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
        throw new Error(getMessage(handlers, 'roomNotFoundSameProject'));
      }
      if (latestRoom.players?.blue === uid) {
        throw new Error(getMessage(handlers, 'sameSessionRoom'));
      }
      if (latestRoom.status !== 'waiting' || latestRoom.players?.orange) {
        throw new Error(getMessage(handlers, 'roomFull'));
      }
      throw new Error(getMessage(handlers, 'roomJoinFailed'));
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
      throw new Error(getMessage(handlers, 'matchmakingQueueFailed'));
    }

    detachRoom();
    await databaseSdk.remove(databaseSdk.ref(database, `rooms/${ownRoomCode}`));
    try {
      await joinRoom(candidate.roomCode);
    } catch (error) {
      const detail = handlers.formatError ? handlers.formatError(error) : error.message || String(error);
      throw new Error(getMessage(handlers, 'matchmakingJoinFailed', { error: detail }));
    }
    return { waiting: false, roomCode: candidate.roomCode };
  }

  async function publishGameState(state){
    if (!roomRef || !role) throw new Error(getMessage(handlers, 'noActiveOnlineRoom'));
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
    if (!result.committed) throw new Error(getMessage(handlers, 'onlineSyncFailed'));
    if (roomRef !== currentRoomRef) return;
  }

  async function finishForfeit(reason){
    if (!roomRef || !role || !roomCode) throw new Error(getMessage(handlers, 'noActiveOnlineRoom'));

    const currentRoomRef = roomRef;
    const currentRole = role;
    const currentCode = roomCode;
    const roomSnapshot = await databaseSdk.get(currentRoomRef);
    const room = roomSnapshot.val();
    if (!room || room.status !== 'playing') return room?.result || null;

    const opponentRole = currentRole === 'blue' ? 'orange' : 'blue';
    if (reason === 'disconnect') {
      const disconnectedUid = room.players?.[opponentRole];
      if (!disconnectedUid) return null;
      const disconnectedSnapshot = await databaseSdk.get(
        databaseSdk.ref(database, `rooms/${currentCode}/presence/${opponentRole}/${disconnectedUid}`)
      );
      if (disconnectedSnapshot.val() !== false) return null;
    }
    const winner = reason === 'forfeit' ? opponentRole : currentRole;

    const resultRef = databaseSdk.ref(database, `rooms/${currentCode}/result`);
    const resultTransaction = await databaseSdk.runTransaction(resultRef, current => {
      if (current !== null) return;
      return { winner, reason, at: Date.now() };
    });
    const finalResult = resultTransaction.snapshot.val();
    if (!finalResult) return null;

    await databaseSdk.runTransaction(currentRoomRef, current => {
      if (!current || current.status !== 'playing') return;
      return { ...current, status: 'finished', result: finalResult };
    });
    return finalResult;
  }

  async function finishMatch(winner){
    if (!roomRef || !role || !roomCode) throw new Error(getMessage(handlers, 'noActiveOnlineRoom'));
    if (!['blue', 'orange', 'draw'].includes(winner)) throw new Error(getMessage(handlers, 'invalidMatchResult'));

    const currentRoomRef = roomRef;
    const currentRole = role;
    const currentCode = roomCode;
    const roomSnapshot = await databaseSdk.get(currentRoomRef);
    const room = roomSnapshot.val();
    const expectedTurn = currentRole === 'blue' ? 'player' : 'ai';
    if (!room || room.status !== 'playing' || room.game?.turn !== expectedTurn) {
      throw new Error(getMessage(handlers, 'matchResultNotConfirmed'));
    }

    const resultRef = databaseSdk.ref(database, `rooms/${currentCode}/result`);
    const resultTransaction = await databaseSdk.runTransaction(resultRef, current => {
      if (current !== null) return;
      return { winner, reason: 'completed', at: Date.now() };
    });
    const finalResult = resultTransaction.snapshot.val();
    if (!finalResult) throw new Error(getMessage(handlers, 'matchResultSaveFailed'));

    await databaseSdk.runTransaction(currentRoomRef, current => {
      if (!current || current.status !== 'playing') return;
      return { ...current, status: 'finished', result: finalResult };
    });
    return finalResult;
  }

  async function leave(){
    const leavingRef = roomRef;
    const leavingCode = roomCode;
    const leavingRole = role;
    const leavingPresenceRef = presenceRef;
    try {
      await clearQueue();
      if (leavingRef && leavingRole) {
        const roomSnapshot = await databaseSdk.get(leavingRef);
        const room = roomSnapshot.val();
        if (room?.status === 'playing') {
          await finishForfeit('forfeit');
        } else if (room?.status === 'waiting') {
          await databaseSdk.runTransaction(leavingRef, current => {
            if (!current || current.status !== 'waiting') return;
            return { ...current, status: 'cancelled' };
          });
        }
      }
    } catch (error) {
      reportError(error);
    } finally {
      if (leavingCode && leavingRole && leavingPresenceRef) {
        try {
          await databaseSdk.onDisconnect(leavingPresenceRef).cancel();
          await databaseSdk.set(leavingPresenceRef, false);
        } catch (error) {
          reportError(error);
        }
      }
      if (roomRef === leavingRef) detachRoom();
    }
  }

  return { createRoom, joinRoom, findRandomMatch, publishGameState, finishForfeit, finishMatch, leave };
}
