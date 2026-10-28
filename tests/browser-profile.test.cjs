const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..');
function client(storage=new Map(), blocked=false){
  const handlers={},elements=new Map(),sent=[];
  const socket={id:'player',on:(event,fn)=>handlers[event]=fn,emit:(...args)=>sent.push(args),connect(){},disconnect(){}};
  const get=id=>{
    if(!elements.has(id)){const classes=new Set(id==='screen-home'?['active']:[]);elements.set(id,{style:{},value:'',textContent:'',innerHTML:'',addEventListener(){},classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)}});}
    return elements.get(id);
  };
  const ctx=vm.createContext({console,io:()=>socket,localStorage:{getItem:k=>{if(blocked)throw Error();return storage.get(k)||null;},setItem:(k,v)=>{if(blocked)throw Error();storage.set(k,v);},removeItem:k=>storage.delete(k)},document:{getElementById:get,querySelectorAll:()=>[]},window:{addEventListener(){},scrollTo(){}},setTimeout(){},setInterval(){},clearInterval(){},location:{reload(){}}});
  vm.runInContext(fs.readFileSync(path.join(root,'public/profile.js'),'utf8'),ctx);
  const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],ctx);
  return {ctx,handlers,elements,sent,storage,run:code=>vm.runInContext(code,ctx)};
}
test('opens without authentication; profile, purchases, and class survive reload',()=>{
  const c=client();assert.equal(c.elements.get('top-bar').style.display,'flex');
  c.run("account.username='Агент';account.coins=1250;saveProfile();buyClass('gambler');equipClass('gambler')");
  assert.equal(c.run('account.coins'),250);
  c.run("buyClass('gambler');buyClass('mellstroy')");assert.equal(c.run('account.coins'),250);
  const reload=client(c.storage);assert.equal(reload.run('account.username'),'Агент');assert.equal(reload.run('account.equippedClass'),'gambler');
  reload.handlers.connect();assert.equal(reload.sent.at(-1)[0],'profile:sync');
  reload.handlers['profile:reward']({amount:100});assert.equal(client(c.storage).run('account.coins'),350);
  assert.ok(!reload.sent.some(([event])=>event.startsWith('account:')));
});
test('corrupt or unavailable storage does not prevent playing',()=>{
  const c=client(new Map([['spy_profile_v1','{broken']]));assert.equal(c.run('account.coins'),0);
  const b=client(new Map(),true);b.run("account.coins=500;saveProfile()");b.handlers['profile:reward']({amount:100});assert.equal(b.run('account.coins'),600);
  const bad=client(new Map([['spy_profile_v1',JSON.stringify({coins:-4,inventory:['invalid'],equippedClass:'invalid'})]]));assert.equal(bad.run('account.equippedClass'),'default');
});
test('anonymous multiplayer uses browser class and awards winners without database',async()=>{
  let connect;const sockets=new Map(),events=[];
  class IO{constructor(){this.sockets={sockets};}on(event,fn){connect=fn;}emit(...args){events.push(['all',...args]);}to(target){return {emit:(...args)=>events.push([target,...args])};}}
  const express=()=>({use(){}});express.static=()=>{};
  const ctx=vm.createContext({require:name=>name==='express'?express:name==='http'?{createServer:()=>({listen(){}})}:name==='socket.io'?{Server:IO}:require(name),__dirname:root,process:{env:{}},console:{log(){}},setTimeout:()=>1,setInterval:()=>1,clearTimeout(){}});
  vm.runInContext(fs.readFileSync(path.join(root,'server.js'),'utf8'),ctx);
  function player(id){const handlers={};const s={id,data:{},on:(e,fn)=>handlers[e]=fn,join(){},emit:(...args)=>events.push([id,...args])};sockets.set(id,s);connect(s);return {handlers,s};}
  const host=player('host'),spy=player('spy'),civilian=player('civilian');let code;
  host.handlers['lobby:create']({name:'Host'},r=>{assert.equal(r.ok,true);code=r.code;});
  for(const [p,name] of [[spy,'Spy'],[civilian,'Civilian']])p.handlers['lobby:join']({code,name},r=>assert.equal(r.ok,true));
  spy.handlers['profile:sync']({equippedClass:'gambler'});
  await host.handlers['game:start']({word:'Марс',traitorId:'spy',maxTurns:3,theme:'Космос'},()=>{});
  assert.equal(vm.runInContext(`lobbies['${code}'].spyClass`,ctx),'gambler');
  vm.runInContext(`lobbies['${code}'].state='playing';lobbies['${code}'].guessing=true`,ctx);
  spy.handlers['game:startGuessing']();
  spy.handlers['game:guessWord']({guess:'Марс'});
  assert.ok(events.some(([to,event,data])=>to==='spy'&&event==='profile:reward'&&data.amount===250));
  assert.ok(!events.some(([to,event])=>to==='host'&&event==='profile:reward'));
  assert.equal(host.handlers['account:login'],undefined);
});
