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
  const c=context({mode:'online',onlineRole:'orange',economy:{stats:{matches:0,bestScore:0,wins:0,winStreak:0}},saveEconomy(){},checkAchievementProgress(){}},['recordMatchResult']);
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
