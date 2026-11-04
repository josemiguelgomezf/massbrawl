// AdMob: App Open al arrancar, intersticial cada 15 min con la app visible y banner inferior.
// Solo actúa dentro de la app nativa (Capacitor); en el navegador no hace nada.
(function () {
  const cap = window.Capacitor;
  const AdMob = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins.AdMob;
  if (!AdMob) return;

  // IDs reales de AdMob. El APPLICATION_ID está en android/app/src/main/res/values/strings.xml.
  const IDS = {
    banner: 'ca-app-pub-9144651039798828/8075427918',
    interstitial: 'ca-app-pub-9144651039798828/5804662801',
    appOpen: 'ca-app-pub-9144651039798828/8183414132',
  };
  const INTERVAL_MS = 15 * 60 * 1000;
  let timer = null;

  // Con el menú y la pantalla final ocultos hay una partida en curso.
  const hidden = (id) => document.getElementById(id)?.classList.contains('hidden');
  const inMatch = () => hidden('menuOverlay') && hidden('overlay');

  const run = (fn) => fn().catch((e) => console.warn('AdMob:', e && e.message ? e.message : e));

  function scheduleInterstitial() {
    clearTimeout(timer);
    if (document.hidden) return;
    timer = setTimeout(async function show() {
      // Un anuncio a pantalla completa en plena partida detendría el turno y dejaría esperando al rival online.
      if (inMatch()) {
        timer = setTimeout(show, 5000);
        return;
      }
      await run(() => AdMob.showInterstitial());
      run(() => AdMob.prepareInterstitial({ adId: IDS.interstitial }));
      scheduleInterstitial();
    }, INTERVAL_MS);
  }

  async function start() {
    // Consentimiento (UMP) obligatorio en el EEE/Reino Unido antes de pedir anuncios.
    let consent = await AdMob.requestConsentInfo();
    if (consent.isConsentFormAvailable && consent.status === 'REQUIRED') {
      consent = await AdMob.showConsentForm();
    }
    if (!consent.canRequestAds) {
      console.warn('AdMob: sin consentimiento, no se piden anuncios', consent.status);
      return;
    }
    await AdMob.initialize();

    await AdMob.addListener('bannerAdSizeChanged', (s) => {
      document.documentElement.style.setProperty('--ad-h', s.height > 0 ? s.height + 'px' : '0px');
    });
    run(() => AdMob.showBanner({ adId: IDS.banner, adSize: 'ADAPTIVE_BANNER', position: 'BOTTOM_CENTER', margin: 0 }));

    run(() => AdMob.prepareInterstitial({ adId: IDS.interstitial }));
    run(async () => {
      await AdMob.loadAppOpen({ adId: IDS.appOpen });
      await AdMob.showAppOpen();
    });
    scheduleInterstitial();
    // El contador solo corre con la app en primer plano.
    document.addEventListener('visibilitychange', scheduleInterstitial);
  }

  run(start);
})();
