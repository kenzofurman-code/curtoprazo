import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/localDatabase.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext}}).outputText;
let sequence=0;
async function setup() {
  const entries=new Map();
  globalThis.localStorage={get length(){return entries.size;},key:i=>[...entries.keys()][i],getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,String(value)),removeItem:key=>entries.delete(key)};
  const db=await import(`data:text/javascript;base64,${Buffer.from(code+`\n// instance ${sequence++}`).toString('base64')}`);
  return {db,entries};
}
const copy = docs => JSON.stringify(docs);

test('banco novo fica vazio, inclusive na assinatura, sem gravar dados ou carregar snapshots',async()=>{
  const {db,entries}=await setup();
  assert.equal(db.isLocalDbMode(),true);
  assert.equal(db.getLocalDocData('projeto_principal'),null);
  const result=await new Promise(resolve=>db.subscribeLocalDoc('all_projects_metadata',resolve));
  assert.equal(result.exists(),false);
  const backup=JSON.parse(db.exportAllLocalData());
  assert.deepEqual(backup.documents,{}); assert.deepEqual(backup.storage,{});
  assert.equal(entries.size,0);
});

test('backup antigo restaura dados e respeita a escolha de não preencher outros documentos',async()=>{
  const {db}=await setup();
  db.setLocalDocData('existente',{value:1});
  const backup=db.parseLocalBackup(copy({all_projects_metadata:{list:[{id:'obra',name:'Minha obra'}]},obra:{floors:[]}}));
  db.importLocalBackup(backup);
  assert.deepEqual(db.getLocalDocData('obra'),{floors:[]});
  assert.deepEqual(db.getLocalDocData('existente'),{value:1});
  assert.equal(db.getLocalDocData('projeto_principal'),null);
});

test('exporta e restaura documentos, partes de cargas, orçamento e configurações sem exportar o modo de conexão',async()=>{
  const {db,entries}=await setup();
  db.setLocalDocData('obra',{payload:{format:'chunks-v1'}});
  db.setLocalDocData('obra_part_0',{payload:'abc'});
  localStorage.setItem('curtoprazo_budget_obra',JSON.stringify({items:[]}));
  const backup=db.parseLocalBackup(db.exportAllLocalData());
  assert.equal(backup.documents.obra_part_0.payload,'abc');
  assert.equal(backup.storage.curtoprazo_budget_obra,'{"items":[]}');
  assert.equal(backup.storage.curtoprazo_use_local_db,undefined);
  entries.clear();db.importLocalBackup(backup);
  assert.equal(localStorage.getItem('curtoprazo_budget_obra'),'{"items":[]}');
  assert.equal(JSON.parse(localStorage.getItem('curtoprazo_local_db_obra_part_0')).payload,'abc');
});

test('trocar bancos isola os dados auxiliares, mantendo ambos e sem copiar documentos para a nuvem',async()=>{
  const {db}=await setup();
  db.setLocalDocData('obra',{local:true});
  localStorage.setItem('curtoprazo_budget_obra','local');
  db.setLocalDbMode(false);
  assert.equal(db.isLocalDbMode(),false);
  assert.equal(localStorage.getItem('curtoprazo_budget_obra'),null);
  localStorage.setItem('curtoprazo_budget_obra','cloud');
  assert.equal(db.parseLocalBackup(db.exportAllLocalData()).storage.curtoprazo_budget_obra,'local');
  db.setLocalDbMode(true);
  assert.equal(localStorage.getItem('curtoprazo_budget_obra'),'local');
  assert.equal(db.getLocalDocData('obra').local,true);
  db.setLocalDbMode(false);
  assert.equal(localStorage.getItem('curtoprazo_budget_obra'),'cloud');
});

test('importar cópia enquanto a nuvem está ativa não altera as configurações da nuvem',async()=>{
  const {db}=await setup();db.setLocalDbMode(false);
  localStorage.setItem('curtoprazo_budget_obra','cloud');
  const backup=db.parseLocalBackup(copy({format:'curtoprazo-local-backup',version:1,documents:{obra:{copied:true}},storage:{curtoprazo_budget_obra:'imported'}}));
  db.importLocalBackup(backup);
  assert.equal(db.isLocalDbMode(),false);
  assert.equal(localStorage.getItem('curtoprazo_budget_obra'),'cloud');
  db.setLocalDbMode(true);
  assert.equal(localStorage.getItem('curtoprazo_budget_obra'),'imported');
});

test('versões e configurações auxiliares de cada modo permanecem isoladas e listas entram no backup',async()=>{
  const {db}=await setup();
  const id='curtoprazo_schedule_versions_obra';
  db.setLocalDocData(id,[{id:'versao-local'}]);
  const backup=db.parseLocalBackup(db.exportAllLocalData());
  assert.deepEqual(backup.documents[id],[{id:'versao-local'}]);
  db.setLocalDbMode(false);
  assert.equal(db.getLocalDocData(id),null);
  db.setLocalDocData(id,[{id:'versao-cloud'}]);
  db.importLocalBackup(backup);
  assert.deepEqual(db.getLocalDocData(id),[{id:'versao-cloud'}]);
  db.setLocalDbMode(true);
  assert.deepEqual(db.getLocalDocData(id),[{id:'versao-local'}]);
});

test('arquivo inválido, versão desconhecida, alteração de modo e lista de obras inválida são rejeitados',async()=>{
  const {db,entries}=await setup();
  for(const bad of ['not json','[]','{"obra":42}','{"__proto__":{}}',copy({format:'other',version:2}),copy({all_projects_metadata:{list:[{id:123,name:'bad'}]}}),copy({format:'curtoprazo-local-backup',version:1,documents:{},storage:{curtoprazo_use_local_db:'false'}})])assert.throws(()=>db.parseLocalBackup(bad));
  assert.equal(entries.size,0);
});

test('falta de espaço reverte a importação sem alterar o cache nem notificar sucesso',async()=>{
  const {db,entries}=await setup();
  db.setLocalDocData('obra',{original:true});
  const originalSet=localStorage.setItem;
  localStorage.setItem=(key,value)=>{if(key.endsWith('_fail'))throw new Error('quota');return originalSet(key,value);};
  const before=[...entries];
  assert.throws(()=>db.importLocalBackup(db.parseLocalBackup(copy({obra:{original:false},fail:{}}))),/dados anteriores foram mantidos/);
  assert.deepEqual([...entries],before);
  assert.deepEqual(db.getLocalDocData('obra'),{original:true});
  assert.equal(db.getLocalDocData('fail'),null);
});

test('falha ao salvar documento local não anuncia gravação somente em memória',async()=>{
  const {db}=await setup();
  localStorage.setItem=()=>{throw new Error('quota');};
  assert.throws(()=>db.setLocalDocData('obra',{test:true}),/quota/);
  assert.equal(db.getLocalDocData('obra'),null);
});

test('falha ao trocar de banco preserva o modo e as configurações anteriores',async()=>{
  const {db,entries}=await setup();
  localStorage.setItem('curtoprazo_budget_obra','local');
  const before=[...entries];
  const originalSet=localStorage.setItem;
  localStorage.setItem=(key,value)=>{if(key==='curtoprazo_use_local_db')throw new Error('quota');return originalSet(key,value);};
  assert.throws(()=>db.setLocalDbMode(false),/dados anteriores foram mantidos/);
  assert.deepEqual([...entries],before);
  assert.equal(db.isLocalDbMode(),true);
});

test('ausência da lista de projetos não cria obras no banco local nem no Firebase',async()=>{
  const app=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
  const effect=app.slice(app.indexOf('  // Carrega a lista de projetos'),app.indexOf('  // Carrega as configurações de acesso'));
  const compiled=ts.transpileModule(effect,{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText;
  for(const db of [{isLocal:true},{}]){
    const writes=[],projectLists=[];
    new Function('context',`const {useEffect,db,userId,appId,doc,onSnapshot,setDoc,setProjects,urlUserId,localStorage,setSelectedProjectId}=context;${compiled}`)({useEffect:fn=>fn(),db,userId:'u',appId:'app',doc:()=>({}),onSnapshot:(_,fn)=>{fn({exists:()=>false});return()=>{};},setDoc:(...args)=>writes.push(args),setProjects:list=>projectLists.push(list),urlUserId:null,localStorage:{removeItem:()=>{}},setSelectedProjectId:()=>{}});
    assert.deepEqual(writes,[]);assert.deepEqual(projectLists,[[]]);
  }
});
