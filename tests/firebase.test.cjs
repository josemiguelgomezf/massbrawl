const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {initializeTestEnvironment,assertSucceeds,assertFails}=require('@firebase/rules-unit-testing');
const sdk=require('firebase/database');
const source=fs.readFileSync('firebase-online.js','utf8')
  .replace('export async function','async function')
  .replace(/  const \[appSdk, authSdk, databaseSdk\] = await Promise\.all\(\[[\s\S]*?\n  \]\);/, '');
const connect=new Function('appSdk','authSdk','databaseSdk',`${source}\nreturn connectFirebaseOnline;`);
async function waitFor(predicate){
  const deadline=Date.now()+5000;
  while(!predicate()){if(Date.now()>deadline)throw Error('Firebase event timeout');await new Promise(r=>setTimeout(r,10));}
}
test('real Realtime Database SDK and rules: matchmaking, turns and results',async(t)=>{
  const env=await initializeTestEnvironment({projectId:'demo-massbrawl-review',database:{host:'127.0.0.1',port:9000,rules:fs.readFileSync('firebase-database.rules.json','utf8')}});
  const clients=[];
  async function client(uid){
    const db=env.authenticatedContext(uid).database();
    const events={states:[],results:[],errors:[],matched:null};
    const handlers={translate:k=>k,onError:e=>events.errors.push(e),onConnection(){},onRoomStatus:status=>events.status=status,onOpponentPresence(){},onMatched:x=>events.matched=x,onGameState:s=>events.states.push(s),onMatchResult:r=>events.results.push(r)};
    const service=await connect({getApps:()=>[{name:'mass-brawl-online'}]},{getAuth:()=>({currentUser:{uid}}),setPersistence:async()=>{},browserSessionPersistence:{}},{...sdk,getDatabase:()=>db})({apiKey:'demo',databaseURL:'http://127.0.0.1:9000'},handlers);
    const c={db,events,service};clients.push(c);return c;
  }
  try{
    const blue=await client('blue'),orange=await client('orange');
    const code=await blue.service.createRoom();
    await orange.service.joinRoom(code);
    await waitFor(()=>blue.events.matched&&orange.events.matched);
    await t.test('empty arrays round trip and turn change reaches opponent',async()=>{
      await blue.service.publishGameState({turn:'ai',busy:false,orbs:[],inventory:{player:[],ai:[{value:1}]}});
      await waitFor(()=>orange.events.states.some(s=>s.turn==='ai'));
      const state=orange.events.states.at(-1);assert.equal(state.orbs,undefined);assert.equal(state.inventory.player,undefined);
    });
    await t.test('invalid and oversized states rejected by deployed rules',async()=>{
      await assertFails(sdk.set(sdk.ref(orange.db,`rooms/${code}/game`),{turn:'bad'}));
      await assertFails(sdk.set(sdk.ref(orange.db,`rooms/${code}/game`),{turn:'ai',orbs:Array(201).fill({value:1})}));
      await assertFails(sdk.set(sdk.ref(orange.db,`rooms/${code}/game`),{turn:'ai',orbs:{unexpected:{value:1}}}));
      await assertSucceeds(sdk.set(sdk.ref(orange.db,`rooms/${code}/game`),{turn:'ai',orbs:Array(200).fill({value:1})}));
    });
    await t.test('active orange player can report a blue victory, retry idempotently',async()=>{
      const result=await orange.service.finishMatch('blue');assert.equal(result.winner,'blue');
      await waitFor(()=>blue.events.results.length&&orange.events.results.length);
      await waitFor(()=>blue.events.status==='finished');
      assert.equal((await sdk.get(sdk.ref(blue.db,`rooms/${code}/status`))).val(),'finished');
      assert.deepEqual(await orange.service.finishMatch('blue'),result);
    });
    await t.test('existing clients can rewrite finished room with unchanged result',async()=>{
      const room=(await sdk.get(sdk.ref(blue.db,`rooms/${code}`))).val();
      await assertSucceeds(sdk.set(sdk.ref(blue.db,`rooms/${code}`),room));
      await assertFails(sdk.set(sdk.ref(blue.db,`rooms/${code}/result`),{winner:'orange',reason:'completed',at:Date.now()}));
    });
    await blue.service.leave();await orange.service.leave();
    await t.test('active blue player can report an orange victory',async()=>{
      const nextCode=await blue.service.createRoom();await orange.service.joinRoom(nextCode);
      await waitFor(()=>blue.events.matched?.roomCode===nextCode&&orange.events.matched?.roomCode===nextCode);
      await blue.service.publishGameState({turn:'player',busy:false});
      assert.equal((await blue.service.finishMatch('orange')).winner,'orange');
      await blue.service.leave();await orange.service.leave();
    });
    await t.test('disconnect result requires absent opponent and finishes room',async()=>{
      const nextCode=await blue.service.createRoom();await orange.service.joinRoom(nextCode);
      await waitFor(()=>blue.events.matched?.roomCode===nextCode&&orange.events.matched?.roomCode===nextCode);
      await blue.service.publishGameState({turn:'player',busy:false});
      assert.equal(await blue.service.finishForfeit('disconnect'),null);
      await sdk.set(sdk.ref(orange.db,`rooms/${nextCode}/presence/orange/orange`),false);
      assert.equal((await blue.service.finishForfeit('disconnect')).winner,'blue');
      await blue.service.leave();await orange.service.leave();
    });
    await t.test('random matchmaking connects two clients with queue permissions',async()=>{
      const first=await blue.service.findRandomMatch();assert.equal(first.waiting,true);
      const second=await orange.service.findRandomMatch();assert.equal(second.waiting,false);
      await waitFor(()=>blue.events.matched?.roomCode===first.roomCode&&orange.events.matched?.roomCode===first.roomCode);
      await blue.service.publishGameState({turn:'player',busy:false});
      const result=await orange.service.finishForfeit('forfeit');assert.equal(result.winner,'blue');
    });
    await blue.service.leave();await orange.service.leave();
    await t.test('waiting room can be cancelled',async()=>{
      const waiting=await blue.service.createRoom();await blue.service.leave();
      assert.equal((await sdk.get(sdk.ref(blue.db,`rooms/${waiting}/status`))).val(),'cancelled');
    });
    assert.deepEqual(blue.events.errors.map(e=>e.message),[]);
    assert.deepEqual(orange.events.errors.map(e=>e.message),[]);
  }finally{
    for(const c of clients)await c.service.leave();
    await env.cleanup();
  }
});
