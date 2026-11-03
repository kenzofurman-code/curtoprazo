import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const source = await readFile(new URL('../src/moduleVisibility.ts', import.meta.url),'utf8');
const code = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext}}).outputText;
const { APP_MODULES, DEFAULT_MODULE_VISIBILITY: defaults, normalizeModuleVisibility, canAccessModule, resolveVisibleTab, createModuleVisibilityStore } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('usuário comum recebe somente Dashboard, Semanal e Configurações por padrão',()=>{
  assert.deepEqual(APP_MODULES.filter(m=>canAccessModule(m.id,defaults,false)).map(m=>m.id),['dashboard','planning','config']);
  assert.equal(canAccessModule('import',defaults,false),false);
  assert.equal(canAccessModule('cronograma-inicial',defaults,false),false);
  assert.equal(canAccessModule('modulo-desconhecido',defaults,true),false);
});

test('administrador autenticado vê todos os módulos, sem depender do nome do operador',()=>{
  const hidden=Object.fromEntries(APP_MODULES.map(m=>[m.id,false]));
  assert.ok(APP_MODULES.every(m=>canAccessModule(m.id,hidden,true)));
  assert.ok(APP_MODULES.every(m=>!canAccessModule(m.id,hidden,false)));
});

test('configuração nova ou inválida não libera módulos em desenvolvimento',()=>{
  assert.deepEqual(normalizeModuleVisibility(undefined),defaults);
  assert.deepEqual(normalizeModuleVisibility([]),defaults);
  const value=normalizeModuleVisibility({lob:'true',table:true,dashboard:false,unknown:true});
  assert.equal(value.lob,false);assert.equal(value.table,true);assert.equal(value.dashboard,false);
  assert.equal(value.unknown,undefined);
});

test('ocultar tela aberta retira seu conteúdo imediatamente e aliases seguem o módulo correspondente',()=>{
  assert.equal(resolveVisibleTab('budget',defaults,false),'dashboard');
  assert.equal(resolveVisibleTab('budget',{...defaults,budget:true},false),'budget');
  assert.equal(resolveVisibleTab('budget',defaults,true),'budget');
  assert.equal(resolveVisibleTab('dashboard',{...defaults,dashboard:false},false),'planning');
  assert.equal(canAccessModule('detalhamento-ppc',defaults,false),true);
  assert.equal(canAccessModule('historico-andamento',{...defaults,dashboard:false},false),false);
  assert.equal(resolveVisibleTab('dashboard',Object.fromEntries(APP_MODULES.map(m=>[m.id,false])),false),null);
});

function backend() {
  let data=null;
  const writes=[],listeners=new Set();
  return { writes, adapter:{
    watch:(path,receive)=>{listeners.add(receive);receive(data);return()=>listeners.delete(receive);},
    write:async(path,next,options)=>{writes.push({path,next,options});data={...data,...next};listeners.forEach(fn=>fn(data));}
  }};
}
test('configuração é compartilhada entre sessões e salva somente o documento de visibilidade',async()=>{
  const db=backend();
  const admin=createModuleVisibilityStore(db.adapter,'app');
  const user=createModuleVisibilityStore(db.adapter,'app');
  let first,second;
  const off1=admin.subscribe(value=>{first=value;},assert.fail);
  const off2=user.subscribe(value=>{second=value;},assert.fail);
  assert.equal(db.writes.length,0,'carregar não grava a base');
  const next={...defaults,budget:true,calendar:true};
  await admin.save(next,true,'Operador autenticado');
  assert.deepEqual(first,next);assert.deepEqual(second,next);
  assert.equal(db.writes.length,1);
  assert.equal(db.writes[0].path,'artifacts/app/public/data/project_measurements/module_visibility');
  assert.deepEqual(db.writes[0].options,{merge:true});
  assert.equal(db.writes[0].next.cronogramaInicial,undefined);
  off1();off2();
});

test('usuário sem autenticação de admin não salva configuração global',async()=>{
  const db=backend();const store=createModuleVisibilityStore(db.adapter,'app');
  await assert.rejects(()=>store.save({...defaults,lob:true},false,'admin'),/Autentique-se/);
  assert.equal(db.writes.length,0);
});

test('falha de gravação é propagada e a configuração anterior não é anunciada como alterada',async()=>{
  let current;
  const store=createModuleVisibilityStore({watch:(_,receive)=>{receive({visibleModules:defaults});return()=>{};},write:async()=>{throw new Error('sem permissão');}},'app');
  store.subscribe(value=>{current=value;},assert.fail);
  await assert.rejects(()=>store.save({...defaults,lob:true},true,'admin'),/sem permissão/);
  assert.deepEqual(current,defaults);
});
