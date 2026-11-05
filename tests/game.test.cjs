const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const html = fs.readFileSync('index.html', 'utf8');
// Execute the actual functions with small substitutes for rendering and Firebase.
function source(name) {
  const start = html.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  const end = html.indexOf('\n  }', start) + 4;
  return html.slice(start, end);
}
function context(values = {}, names = []) {
  const ctx = vm.createContext(values);
  vm.runInContext(names.map(source).join('\n'), ctx);
  return ctx;
}
function snapshotContext() {
  return context({ MAX_ONLINE_ORBS:200, MAX_MASS:5, W:100,H:100,TURN_SECONDS:60,
    selectedInventory:{player:null,ai:null},onlineRole:'blue',onlineStateRevision:0,
    orbs:['unchanged'], inventory:{player:['unchanged'],ai:[]}, physicsAccumulator:1,
    clamp:(x,a,b)=>Math.max(a,Math.min(x,b)), clearTimeout(){},finalDelayTimer:null,
    overlay:{classList:{add(){}}},onlineOverlay:{classList:{add(){}}},menuOverlay:{classList:{add(){}}},
    renderInventory(){}, turnEl:{},helpText:{},turnLabel(){},buildHelpText(){},
    updateTurnUI(){},updateTimerDisplay(){},setOnlineStatus(){},orbRadius:()=>5,
  }, ['applyOnlineGameState']);
}
test('Firebase omitted empty arrays apply the next turn instead of freezing', () => {
  const c=snapshotContext();c.applyOnlineGameState({turn:'ai',revision:2});
  assert.equal(c.turn,'ai');assert.equal(c.orbs.length,0);assert.equal(c.inventory.ai.length,0);
  assert.equal(c.onlineStateRevision,2);assert.equal(c.physicsAccumulator,0);
});
for(const state of [{orbs:{}},{inventory:{player:{}}},{inventory:{ai:'oops'}},{orbs:Array(201).fill({})}]) {
  test(`invalid snapshot is ignored atomically: ${JSON.stringify(state).slice(0,70)}`, () => {
    const c=snapshotContext();c.applyOnlineGameState({turn:'ai',...state});
    assert.equal(c.orbs[0],'unchanged');assert.equal(c.inventory.player[0],'unchanged');
  });
}
test('malformed link offsets cannot crash snapshot processing',()=>{
  const c=snapshotContext();const orbs=['a','b'].map(id=>({id,team:'player',value:1,x:1,y:1,vx:0,vy:0}));
  c.applyOnlineGameState({turn:'ai',orbs,groups:[{anchor:'a',members:['a','b'],vx:0,vy:0,offsets:{bad:true}}]});
  assert.equal(c.orbs.length,2);
});
test('result retries stop after returning to menu or starting another match',async()=>{
  const callbacks=[];let calls=0;
  const c=context({matchGeneration:1,started:true,mode:'online',onlineService:{finishMatch:async()=>{calls++;throw Error('offline');}},setTimeout:fn=>callbacks.push(fn),setOnlineStatus(){},onlineErrorMessage:e=>e.message},['saveOnlineResult']);
  c.saveOnlineResult('blue');await new Promise(setImmediate);assert.equal(calls,1);
  c.matchGeneration++;callbacks[0]();await new Promise(setImmediate);assert.equal(calls,1);
});
test('confirmed online winner determines stats even with stale local scores',()=>{
  const c=context({window:{},mode:'online',onlineRole:'orange',economy:{stats:{matches:0,bestScore:0,wins:0,winStreak:0}},saveEconomy(){},checkAchievementProgress(){}},['recordMatchResult']);
  c.recordMatchResult({player:10,ai:0},'orange');assert.equal(c.economy.stats.wins,1);
});
test('match rewards are granted once despite duplicate result events',()=>{
  const c=context({matchRewardsGranted:false,economy:{coins:0},MATCH_REWARD:100,saveEconomy(){},renderEconomy(){},renderShop(){},recordMatchResult(){}},['grantMatchRewards']);
  c.grantMatchRewards({});c.grantMatchRewards({});assert.equal(c.economy.coins,100);
});
function loopContext() {
  const noop=()=>{};const c=context({started:true,gameOver:false,lastTs:0,MAX_FRAME_SECONDS:.1,PHYSICS_STEP_SECONDS:1/60,physicsAccumulator:0,busy:true,mode:'online',turn:'player',playerTimeLeft:.001,aiTimeLeft:60,dragOrb:null,aiTimer:null,
    physicsStep:noop,detonateBombs:noop,isOnlineTeamLocal:t=>t==='player',onlineSyncElapsed:0,publishOnlineGameState:noop,allStationary:()=>false,updateExplosions:noop,canPlay:()=>true,
    turnEl:{},helpText:{},turnLabel:noop,buildHelpText:noop,updateTurnUI:noop,updateTimerDisplay:noop,checkGameEnd:noop,computeScores:()=>({player:0,ai:0}),scoreLeftEl:{},scoreRightEl:{},ctx:{save:noop,restore:noop},isOrangePerspective:()=>false,drawBoard:noop,orbs:[],drawOrb:noop,drawExplosions:noop,drawDrag:noop,requestAnimationFrame:noop,cancelExpiredDrag:noop},['loop']);
  return c;
}
test('timeout during moving shot keeps authority until movement settles',()=>{
  const c=loopContext();c.loop(17);assert.equal(c.playerTimeLeft,0);assert.equal(c.turn,'player');assert.equal(c.busy,true);
});
test('fixed physics runs equally at 60 and 120 Hz',()=>{
  function steps(fps){const c=loopContext();let n=0;c.physicsStep=()=>n++;c.playerTimeLeft=60;for(let i=1;i<=fps;i++)c.loop(i*1000/fps);return n;}
  assert.ok(Math.abs(steps(60)-steps(120))<=1);
});
test('expired drag is restored and cleared before handing off the turn',()=>{
  const c=context({dragOrb:{team:'player',value:2},dragStart:{},dragCurrent:{},inventory:{player:[]},renderInventory(){}},['cancelExpiredDrag']);
  c.cancelExpiredDrag();assert.equal(c.dragOrb,null);assert.equal(c.inventory.player[0].value,2);
});
test('new game does not start a second animation loop',()=>{
  assert.equal((html.match(/requestAnimationFrame\(loop\)/g)||[]).length,2);
  assert.ok(!source('newGame').includes('requestAnimationFrame'));
});
test('a busy remote prediction accepts a snapshot that hands off the turn',()=>{
  const c=snapshotContext();Object.assign(c,{started:true,mode:'online',gameOver:false,dragOrb:null,busy:true,turn:'ai',isOnlineTeamLocal:team=>team==='player'});
  const start=html.indexOf('      onGameState(state){');const end=html.indexOf('\n      },',start);
  vm.runInContext('function onGameState(state){'+html.slice(start+'      onGameState(state){'.length,end)+'\n}',c);
  c.onGameState({turn:'player',busy:true,revision:3,inventory:{player:[{value:1}]}});
  assert.equal(c.turn,'player');assert.equal(c.onlineStateRevision,3);
});
// Google Play Games
const allAchievementIds=[...html.matchAll(/\{ id: '(\w+)', title:/g)].map(m=>m[1]);
function playGames({authenticated=true,stored=null,unlock=async()=>{},signIn=async()=>({authenticated:true})}={}){
  const calls={unlock:[],score:[],signIn:0,achievementsUi:0,leaderboardUi:[]};const store={};const listeners=[];
  if(stored)store.massBrawlPlayGamesSynced=stored;
  const plugin={isAuthenticated:async()=>({authenticated:calls.session??authenticated}),
    signIn:async()=>{calls.signIn++;return signIn();},
    unlockAchievement:o=>{calls.unlock.push(o.id);return unlock(o);},
    submitScore:async o=>{calls.score.push(o);},
    showAchievements:async()=>{calls.achievementsUi++;},
    showLeaderboard:async o=>{calls.leaderboardUi.push(o.leaderboardId);}};
  const window={Capacitor:{isNativePlatform:()=>true,Plugins:{PlayGames:plugin}}};
  const ctx=vm.createContext({window,console:{warn(){}},document:{hidden:false,addEventListener:(_,fn)=>listeners.push(fn)},
    localStorage:{getItem:k=>store[k]??null,setItem:(k,v)=>{store[k]=v;}}});
  vm.runInContext(fs.readFileSync('play-games.js','utf8'),ctx);
  return {api:window.MassBrawlPlayGames,calls,store,resume:()=>listeners.forEach(fn=>fn())};
}
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};
function achievementContext(stats,extra={}){
  const sent=[];const ctx=context({window:{MassBrawlPlayGames:{syncAchievements:ids=>sent.push(...ids)}},economy:{stats,...extra},
    achievementDefinitions:[{id:'first_win',stat:'wins',thresholds:[1,3]},{id:'score_ten',stat:'bestScore',thresholds:[10,15]},{id:'all_specials',stat:'specialSets',thresholds:[1,2]}]},
    ['achievementMetric','syncPlayGamesAchievements']);
  ctx.syncPlayGamesAchievements();return sent;
}
test('Play Games unlock rule is metric >= first threshold',()=>{
  assert.deepEqual(achievementContext({wins:0,bestScore:9,bombUses:1,spikedUses:1,ghostUses:0}),[]);
  assert.deepEqual(achievementContext({wins:1,bestScore:10,bombUses:1,spikedUses:1,ghostUses:1}),['first_win','score_ten','all_specials']);
});
test('Play Games unlock ignores claimed and notified levels',()=>{
  assert.deepEqual(achievementContext({wins:1},{achievementLevels:{},notifiedAchievementLevels:{}}),['first_win']);
  assert.deepEqual(achievementContext({wins:50},{achievementLevels:{first_win:5},notifiedAchievementLevels:{first_win:5}}),['first_win']);
});
test('checkAchievementProgress syncs with Play Games and grants nothing',()=>{
  let synced=0;const economy={coins:7,stats:{wins:1},achievementLevels:{},notifiedAchievementLevels:{}};
  const c=context({economy,achievementDefinitions:[],achievementToastQueue:[],saveEconomy(){},renderEconomy(){},renderAchievements(){},syncPlayGamesAchievements(){synced++;}},['checkAchievementProgress']);
  c.checkAchievementProgress();assert.equal(synced,1);assert.equal(economy.coins,7);
});
test('all 12 achievements map to a Play id and existing progress syncs on sign-in',async()=>{
  assert.equal(allAchievementIds.length,12);
  const p=playGames();p.api.syncAchievements(allAchievementIds);await settle();
  assert.equal(new Set(p.calls.unlock).size,12);assert.ok(p.calls.unlock.every(id=>id.startsWith('CgkIs5nC3IEEEAIQ')));
  assert.equal(JSON.parse(p.store.massBrawlPlayGamesSynced).length,12);
});
test('already synced achievements are not sent again, also after restart',async()=>{
  const p=playGames({stored:'["first_win"]'});p.api.syncAchievements(['first_win','hard_win']);await settle();
  p.api.syncAchievements(['first_win','hard_win']);await settle();
  assert.deepEqual(p.calls.unlock,['CgkIs5nC3IEEEAIQBw']);
});
test('overlapping syncs send an achievement only once',async()=>{
  const p=playGames();await settle();p.api.syncAchievements(['first_win']);p.api.syncAchievements(['first_win']);await settle();
  assert.equal(p.calls.unlock.length,1);
});
test('failed unlock is not marked and retries on the next sync',async()=>{
  let fail=true;const p=playGames({unlock:async()=>{if(fail)throw Error('offline');}});
  p.api.syncAchievements(['first_win']);await settle();
  assert.equal(p.calls.unlock.length,1);assert.equal(p.store.massBrawlPlayGamesSynced,undefined);
  fail=false;p.api.syncAchievements(['first_win']);await settle();
  assert.equal(p.calls.unlock.length,2);assert.equal(p.store.massBrawlPlayGamesSynced,'["first_win"]');
});
test('without a session nothing is sent, and it syncs when returning with one',async()=>{
  const p=playGames({authenticated:false});p.api.syncAchievements(['first_win']);p.api.submitScore(5);await settle();
  assert.equal(p.calls.unlock.length,0);assert.equal(p.calls.score.length,0);assert.equal(p.calls.signIn,0);
  p.calls.session=true;p.resume();await settle();assert.equal(p.calls.unlock.length,1);
});
test('corrupt synced storage is ignored',async()=>{
  const p=playGames({stored:'{oops'});p.api.syncAchievements(['first_win']);await settle();assert.equal(p.calls.unlock.length,1);
});
test('zero scores are not submitted',async()=>{
  const p=playGames();await settle();p.api.submitScore(0);p.api.submitScore(12);await settle();
  assert.deepEqual(p.calls.score.map(o=>[o.leaderboardId,o.score]),[['CgkIs5nC3IEEEAIQDQ',12]]);
});
function scoreSent(values,scores){
  const sent=[];const c=context({window:{MassBrawlPlayGames:{submitScore:s=>sent.push(s)}},economy:{stats:{matches:0,bestScore:0,wins:0,winStreak:0}},saveEconomy(){},checkAchievementProgress(){},...values},['recordMatchResult']);
  c.recordMatchResult(scores);return{sent,stats:c.economy.stats};
}
test('leaderboard receives localScore, never the rival score from bestScore',()=>{
  const ai=scoreSent({mode:'ai',difficulty:'easy'},{player:4,ai:9});assert.deepEqual(ai.sent,[4]);assert.equal(ai.stats.bestScore,9);
  assert.deepEqual(scoreSent({mode:'online',onlineRole:'orange'},{player:9,ai:4}).sent,[4]);
  assert.deepEqual(scoreSent({mode:'online',onlineRole:'blue'},{player:9,ai:4}).sent,[9]);
});
test('leaderboard is not submitted in pvp',()=>{
  assert.deepEqual(scoreSent({mode:'pvp'},{player:9,ai:4}).sent,[]);
});
test('native screens: signed in opens directly, otherwise signIn first',async()=>{
  const p=playGames();assert.equal(await p.api.showAchievements(),true);assert.equal(p.calls.signIn,0);assert.equal(p.calls.achievementsUi,1);
  const q=playGames({authenticated:false});assert.equal(await q.api.showLeaderboard(),true);assert.equal(q.calls.signIn,1);assert.deepEqual(q.calls.leaderboardUi,['CgkIs5nC3IEEEAIQDQ']);
});
test('cancelled or failed signIn reports failure and does not open the screen',async()=>{
  const p=playGames({authenticated:false,signIn:async()=>({authenticated:false})});assert.equal(await p.api.showAchievements(),false);assert.equal(p.calls.achievementsUi,0);
  const q=playGames({authenticated:false,signIn:async()=>{throw Error('no');}});assert.equal(await q.api.showAchievements(),false);
});
test('outside the native app the bridge does nothing',()=>{
  for(const Capacitor of [undefined,{isNativePlatform:()=>false,Plugins:{}}]){
    const window={Capacitor};vm.runInNewContext(fs.readFileSync('play-games.js','utf8'),{window});
    assert.equal(window.MassBrawlPlayGames,undefined);
  }
});
test('web build includes play-games.js and index.html loads it',()=>{
  assert.ok(fs.readFileSync('scripts/build-web.js','utf8').includes("'play-games.js'"));
  assert.ok(html.includes('<script src="play-games.js"></script>'));
});
