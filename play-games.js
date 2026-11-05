// Google Play Games: sesión, logros y marcador.
// Solo actúa dentro de la app nativa (Capacitor); en el navegador no hace nada y MassBrawlPlayGames no existe.
(function () {
  const cap = window.Capacitor;
  const plugin = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins.PlayGames;
  if (!plugin) return;

  const ACHIEVEMENT_IDS = {
    first_launch: 'CgkIs5nC3IEEEAIQAQ',
    bomb_launch: 'CgkIs5nC3IEEEAIQAg',
    spiked_launch: 'CgkIs5nC3IEEEAIQAw',
    ghost_launch: 'CgkIs5nC3IEEEAIQBA',
    all_specials: 'CgkIs5nC3IEEEAIQBQ',
    first_win: 'CgkIs5nC3IEEEAIQBg',
    hard_win: 'CgkIs5nC3IEEEAIQBw',
    pvp_win: 'CgkIs5nC3IEEEAIQCA',
    score_ten: 'CgkIs5nC3IEEEAIQCQ',
    double_bomb: 'CgkIs5nC3IEEEAIQCg',
    streak_3: 'CgkIs5nC3IEEEAIQCw',
    matches_10: 'CgkIs5nC3IEEEAIQDA',
  };
  const LEADERBOARD_ID = 'CgkIs5nC3IEEEAIQDQ';
  const SYNCED_KEY = 'massBrawlPlayGamesSynced';

  const warn = (e) => console.warn('PlayGames:', e && e.message ? e.message : e);

  function loadSynced() {
    try {
      const stored = JSON.parse(localStorage.getItem(SYNCED_KEY));
      return Array.isArray(stored) ? stored : [];
    } catch (e) {
      return [];
    }
  }

  const synced = new Set(loadSynced());
  const sending = new Set();
  let earned = [];
  let authenticated = false;
  let opening = false;

  function saveSynced() {
    try {
      localStorage.setItem(SYNCED_KEY, JSON.stringify([...synced]));
    } catch (e) {
      warn(e); // Sin almacenamiento se reenvía en la próxima sesión; Play ignora los ya desbloqueados.
    }
  }

  // Lo que falle no se marca: se reintenta en la siguiente llamada.
  function flushAchievements() {
    if (!authenticated) return;
    for (const id of earned) {
      if (!ACHIEVEMENT_IDS[id] || synced.has(id) || sending.has(id)) continue;
      sending.add(id);
      plugin.unlockAchievement({ id: ACHIEVEMENT_IDS[id] })
        .then(() => {
          synced.add(id);
          saveSynced();
        })
        .catch(warn)
        .finally(() => sending.delete(id));
    }
  }

  async function refreshSession() {
    try {
      authenticated = (await plugin.isAuthenticated()).authenticated === true;
    } catch (e) {
      authenticated = false;
      warn(e);
    }
    flushAchievements();
    return authenticated;
  }

  async function openScreen(show) {
    if (opening) return true;
    opening = true;
    try {
      if (!(await refreshSession())) {
        authenticated = (await plugin.signIn()).authenticated === true;
        if (!authenticated) return false;
        flushAchievements();
      }
      await show();
      return true;
    } catch (e) {
      warn(e);
      return false;
    } finally {
      opening = false;
    }
  }

  window.MassBrawlPlayGames = {
    syncAchievements(ids) {
      earned = ids;
      flushAchievements();
    },
    submitScore(score) {
      if (!authenticated || !(score > 0)) return;
      plugin.submitScore({ leaderboardId: LEADERBOARD_ID, score }).catch(warn);
    },
    showAchievements: () => openScreen(() => plugin.showAchievements()),
    showLeaderboard: () => openScreen(() => plugin.showLeaderboard({ leaderboardId: LEADERBOARD_ID })),
  };

  refreshSession();
  // Al volver a la app: pudo recuperar la conexión o cambiar la sesión.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshSession();
  });
})();
