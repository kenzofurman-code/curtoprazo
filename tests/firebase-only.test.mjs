import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { cloudTestModules } from './helpers/cloudTestModules.mjs';

test('sem autenticação Firebase não existe gravação alternativa no navegador',async()=>{
  const {client,backend}=cloudTestModules();
  await assert.rejects(()=>client.readFirebaseDocument('obra'),/Firebase/);
  await assert.rejects(()=>client.saveFirebaseDocument('obra',{valor:1}),/Firebase/);
  assert.equal(backend.writes.length,0);
  assert.equal(client.getCachedFirebaseDocument('obra'),null);
});
test('lê documentos existentes no Firebase sem criar dados nem alterar o formato durante leitura',async()=>{
  const {client,backend}=cloudTestModules();
  const old={projectId:'obra',items:[{id:'real',cost:1234.56}],notes:'Orçamento existente'};
  backend.documents.set('curtoprazo_budget_obra',old);
  client.configureFirebaseDocuments({},'app');
  assert.deepEqual(await client.readFirebaseDocument('curtoprazo_budget_obra'),old);
  assert.deepEqual(client.getCachedFirebaseDocument('curtoprazo_budget_obra'),old);
  assert.equal(backend.writes.length,0);
  assert.deepEqual(backend.documents.get('curtoprazo_budget_obra'),old);
});
test('grava e recupera 9000 atividades no Firebase preservando Unicode, valores e dependências',async()=>{
  const {client,backend}=cloudTestModules();client.configureFirebaseDocuments({},'app');
  const value=Array.from({length:9000},(_,i)=>({id:String(i),service:`Concretagem — ${i}`,progress:37.5,cost:i*137.91,predecessors:i?[String(i-1)]:[]}));
  await client.mutateFirebaseDocument('curtoprazo_schedule_versions_obra',()=>[{id:'v1',snapshot:{cronogramaInicial:value}}]);
  const actual=await client.readFirebaseDocument('curtoprazo_schedule_versions_obra');
  assert.deepEqual(actual[0].snapshot.cronogramaInicial,value);
  assert.equal(backend.documents.get('curtoprazo_schedule_versions_obra').encoding,'gzip-json-v1');
});
test('cargas acima de um documento usam partes verificadas e publicação atômica',async()=>{
  const {client,backend}=cloudTestModules();client.configureFirebaseDocuments({},'app');
  const payload={data:randomBytes(1200000).toString('base64'),label:'Carga grande'};
  await client.saveFirebaseDocument('large',payload);
  const manifest=backend.documents.get('large').payload;
  assert.equal(manifest.format,'chunks-v1');assert.ok(manifest.ids.length>1);
  for(const {value}of backend.writes)assert.ok(Buffer.byteLength(JSON.stringify(value))<1048576);
  assert.deepEqual(await client.readFirebaseDocument('large'),payload);
  backend.failWrite=true;
  const before=structuredClone(backend.documents);
  await assert.rejects(()=>client.saveFirebaseDocument('large',{...payload,label:'não deve entrar'}),/recusou/);
  assert.deepEqual(backend.documents,before);
});
test('falha de gravação mantém dados confirmados e permite repetir sem salvar somente em memória',async()=>{
  const {client,backend}=cloudTestModules();client.configureFirebaseDocuments({},'app');
  await client.saveFirebaseDocument('budget',{total:100});
  backend.failWrite=true;
  await assert.rejects(()=>client.saveFirebaseDocument('budget',{total:200}),/recusou/);
  assert.deepEqual(client.getCachedFirebaseDocument('budget'),{total:100});
  backend.failWrite=false;await client.retryFirebaseWrites();
  assert.deepEqual(await client.readFirebaseDocument('budget'),{total:200});
});
test('atualizações simultâneas preservam ambas as versões na transação do Firebase',async()=>{
  const {client}=cloudTestModules();client.configureFirebaseDocuments({},'app');
  await Promise.all(['A','B'].map(id=>client.mutateFirebaseDocument('versions',previous=>[...(previous||[]),{id}])));
  assert.deepEqual((await client.readFirebaseDocument('versions')).map(v=>v.id),['A','B']);
});

test('reverter uma edição com falha para o valor confirmado cancela a repetição antiga',async()=>{
  const {client,backend}=cloudTestModules();client.configureFirebaseDocuments({},'app');
  await client.saveFirebaseDocument('budget',{total:100});
  backend.failWrite=true;
  await assert.rejects(()=>client.saveFirebaseDocument('budget',{total:200}));
  await client.saveFirebaseDocument('budget',{total:100});
  backend.failWrite=false;await client.retryFirebaseWrites();
  assert.deepEqual(await client.readFirebaseDocument('budget'),{total:100});
});
test('carregamento das configurações da obra vem da nuvem e falha bloqueia a inicialização',async()=>{
  const {client,backend}=cloudTestModules();client.configureFirebaseDocuments({},'app');
  backend.documents.set('curtoprazo_macroflow_obra',{swimlanes:[],interLinks:[]});
  await client.primeProjectFirebaseDocuments('obra');
  assert.equal(backend.reads.length,5);assert.equal(backend.writes.length,0);
  assert.deepEqual(JSON.parse(client.cloudStorage.getItem('curtoprazo_macroflow_obra')),{swimlanes:[],interLinks:[]});
  backend.failRead=true;
  await assert.rejects(()=>client.primeProjectFirebaseDocuments('outra'),/conexão/);
});
test('ausência ou corrupção de uma parte impede sobrescrever o documento salvo',async()=>{
  const {client,backend}=cloudTestModules();client.configureFirebaseDocuments({},'app');
  await client.saveFirebaseDocument('big',{value:randomBytes(1200000).toString('base64')});
  backend.documents.delete(backend.documents.get('big').payload.ids[0]);
  const writes=backend.writes.length;
  await assert.rejects(()=>client.mutateFirebaseDocument('big',()=>({replacement:true})),/ausente|incompleta/);
  assert.equal(backend.writes.length,writes);
});
test('dados de negócio não usam localStorage, IndexedDB ou alternância de banco',async()=>{
  const directory=new URL('../src/',import.meta.url);
  for(const name of await readdir(directory)){
    if(!/\.(tsx|ts)$/.test(name))continue;
    const source=await readFile(new URL(name,directory),'utf8');
    if(name==='App.tsx'){
      const keys=[...source.matchAll(/localStorage\.(?:getItem|setItem|removeItem)\('([^']+)'/g)].map(m=>m[1]);
      assert.ok(keys.every(key=>['planner_username','selected_project_id'].includes(key)));
    }else assert.doesNotMatch(source,/\blocalStorage\b|\bindexedDB\b/,name);
    assert.doesNotMatch(source,/isLocalDbMode|LocalDatabaseSettings|\.\/localDatabase|curtoprazo_use_local_db/,name);
  }
});
