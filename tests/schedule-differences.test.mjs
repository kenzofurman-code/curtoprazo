import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { cloudTestModules } from './helpers/cloudTestModules.mjs';
const source = await readFile(new URL('../src/scheduleDifferences.ts', import.meta.url), 'utf8');
const compile = text => ts.transpileModule(text, {compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const { generatePlanningFromVersions: generate, getLatestImportedVersion } = await import(`data:text/javascript;base64,${Buffer.from(compile(source)).toString('base64')}`);
const item = (id, progress, extra={}) => ({id,progress,floor:'Térreo',macro:'Estrutura',service:`Serviço ${id}`,end:'2026-11-13',responsible:'Equipe Civil',...extra});
const version = (id, progress, extra={}) => ({id,name:id,createdAt:`2026-11-0${id.slice(-1)}T12:00:00Z`,sourceFileName:`${id}.xlsx`,snapshot:{cronogramaInicial:[item('a',progress)],floors:['Térreo'],allFloorsData:{}},...extra});
const week='2026-11-02';

test('compara qualquer referência com a última importação, sem somar intervalos intermediários',()=>{
  const a=version('v1',30), b=version('v2',50), c=version('v3',75);
  const manual=version('v4',90,{sourceFileName:undefined});
  const promoted=version('v5',90,{origin:'promotion'});
  const latest=getLatestImportedVersion([manual,promoted,a,c,b]);
  assert.equal(latest.id,'v3');
  const ac=generate(a,latest,[],week,'Teste');
  assert.equal(ac.diffs[0].delta,45);
  assert.equal(ac.planning[0].executedBeforeRaw,30);
  assert.equal(ac.planning[0].progressThisWeek,75);
  assert.equal(generate(b,latest,[],week,'Teste').diffs[0].delta,25);
  assert.equal(ac.planning[0].targetVersionId,'v3');
});

test('atualiza tarefa aberta sem duplicar e preserva metas, observações e semanas anteriores',()=>{
  const old={id:'history',itemId:'a',weekId:'2026-10-26',executedBeforeRaw:0,progressThisWeek:30,finalized:true};
  const planned={id:'planned',itemId:'a',weekId:week,plannedThisWeek:80,observations:'Manter equipe',progressThisWeek:30};
  const input=[old,planned];
  const result=generate(version('v1',37.5),version('v3',75),input,week,'Engenharia');
  assert.equal(result.planning.length,2);
  assert.deepEqual(result.planning[0],old);
  const task=result.planning[1];
  assert.equal(task.id,'planned'); assert.equal(task.plannedThisWeek,80);
  assert.equal(task.observations,'Manter equipe');assert.equal(task.executedBeforeRaw,37.5);
  assert.equal(task.lastUpdatedBy,'Engenharia');assert.equal(planned.progressThisWeek,30);
});

test('somente avanço positivo de atividades folha entra no curto prazo',()=>{
  const previous=version('v1',10), latest=version('v3',50);
  previous.snapshot.cronogramaInicial=[item('a',10),item('decrease',80),item('equal',25),item('removed',80)];
  latest.snapshot.cronogramaInicial=[item('a',50),item('decrease',20),item('equal',25),item('new',12.5),item('parent',100,{isParent:true,service:'Estrutura'}),item('zero',0)];
  const result=generate(previous,latest,[],week,'Teste');
  assert.deepEqual(result.diffs.map(d=>d.itemId),['a','new']);
  assert.equal(result.diffs[1].delta,12.5);
  assert.equal(result.planning[1].plannedThisWeek,0);
  assert.equal(result.planning[1].isUnplannedDetected,true);
});

test('repetir uma comparação não gera novo lançamento, mesmo em outra semana',()=>{
  const a=version('v1',30), c=version('v3',75);
  const result=generate(a,c,[],week,'Teste');
  assert.equal(generate(a,c,result.planning,week,'Teste',result.budgetDiffs).diffs.length,0);
  assert.equal(generate(a,c,[],'2026-11-09','Teste',result.budgetDiffs).diffs.length,0);
  assert.throws(()=>generate(version('v2',50),c,result.planning,'2026-11-09','Teste'),/outra semana/);
  const changed=generate(version('v2',50),c,result.planning,week,'Teste',result.budgetDiffs);
  assert.equal(changed.planning.length,1);assert.equal(changed.planning[0].executedBeforeRaw,50);
  const restored=generate(a,c,changed.planning,week,'Teste',changed.budgetDiffs);
  assert.equal(restored.planning.length,1);assert.equal(restored.planning[0].executedBeforeRaw,30);
  assert.equal(restored.budgetDiffs.length,2);
});

test('semana finalizada e comparação inválida não alteram dados',()=>{
  const a=version('v1',30), c=version('v3',75), tasks=[{id:'closed',weekId:week,finalized:true}];
  assert.throws(()=>generate(a,c,tasks,week,'Teste'),/finalizadas/);
  assert.deepEqual(tasks,[{id:'closed',weekId:week,finalized:true}]);
  assert.throws(()=>generate(a,a,[],week,'Teste'),/diferente/);
});

test('9000 diferenças são geradas sem corte e mantêm rastreabilidade por atividade',()=>{
  const a=version('v1',0), c=version('v3',0);
  a.snapshot.cronogramaInicial=Array.from({length:9000},(_,i)=>item(String(i),25));
  c.snapshot.cronogramaInicial=a.snapshot.cronogramaInicial.map(value=>({...value,progress:37.5}));
  const result=generate(a,c,[],week,'Teste');
  assert.equal(result.planning.length,9000);assert.equal(result.budgetDiffs.length,9000);
  assert.ok(result.diffs.every(diff=>diff.delta===12.5));
  assert.equal(generate(a,c,result.planning,week,'Teste').diffs.length,0);
});

test('sincronização semanal preserva a referência escolhida e o avanço exato',async()=>{
  const app=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
  const helpers=compile(app.slice(app.indexOf('// --- Utilitários'),app.indexOf('// --- Configuração Firebase')));
  const sync=new Function(`${helpers}; return syncPlanningAndPhysical;`)();
  const current=generate(version('v1',37.5),version('v3',75),[],week,'Teste').planning[0];
  const prior={...current,id:'prior',weekId:'2026-10-26',source:undefined,executedBeforeRaw:0,progressThisWeek:25,finalized:true};
  const result=sync([prior,current],{},[]).recalculatedPlanning;
  assert.equal(result[1].executedBeforeRaw,37.5);
  assert.equal(result[1].progressThisWeek,75);
});

test('Firebase respeita importar sem ativar, ativação explícita e desativação sem substituta',async()=>{
  const {client,versions}=cloudTestModules();client.configureFirebaseDocuments({},'test');
  const snap=version('v1',30).snapshot;
  const first=await versions.createNewScheduleVersion('obra','Primeiro','',true,snap);
  const second=await versions.createNewScheduleVersion('obra','Segundo','',false,snap,{makeActive:false,sourceFileName:'segundo.xlsx'});
  assert.equal(second.created.isActive,false);
  assert.equal(second.versions.find(v=>v.id===first.created.id).isActive,true);
  const active=await versions.activateScheduleVersion('obra',second.created.id);
  assert.deepEqual(active.versions.filter(v=>v.isActive).map(v=>v.id),[second.created.id]);
  const inactive=await versions.deactivateScheduleVersion('obra',second.created.id);
  assert.equal(inactive.filter(v=>v.isActive).length,0);
});

test('excluir baseline e última versão não recria o histórico nem ativa outra versão',async()=>{
  const {client,versions,backend}=cloudTestModules();client.configureFirebaseDocuments({},'test');
  const existing={planning:[{id:'medição',progress:37.5}],history:[{ppc:80}]};
  backend.documents.set('obra',structuredClone(existing));
  const snap=version('v1',30).snapshot;
  const initial=await versions.loadScheduleVersions('obra',snap);
  const next=await versions.createNewScheduleVersion('obra','Nova','',false,snap);
  let list=await versions.deleteScheduleVersion('obra',next.created.id);
  assert.equal(list.length,1);assert.equal(list[0].isActive,false);
  list=await versions.deleteScheduleVersion('obra',initial[0].id);
  assert.deepEqual(list,[]);
  assert.deepEqual(await versions.loadScheduleVersions('obra',snap),[]);
  assert.equal(await versions.getBaselineVersion('obra'),null);
  assert.deepEqual(backend.documents.get('obra'),existing);
});

test('falha do Firebase não exclui nem desativa o registro confirmado',async()=>{
  const {client,versions,backend}=cloudTestModules();client.configureFirebaseDocuments({},'test');
  const created=await versions.createNewScheduleVersion('obra','Ativa','',true,version('v1',30).snapshot);
  backend.failWrite=true;
  await assert.rejects(()=>versions.deleteScheduleVersion('obra',created.created.id),/recusou/);
  await assert.rejects(()=>versions.deactivateScheduleVersion('obra',created.created.id),/recusou/);
  const list=await versions.loadScheduleVersions('obra');
  assert.equal(list.length,1);assert.equal(list[0].isActive,true);
});

test('gerador só atualiza estado e anuncia sucesso depois da persistência do planejamento',async()=>{
  const app=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
  const handler=compile(app.slice(app.indexOf('  const handleGeneratePlanningFromBudgetDiffs ='),app.indexOf('  const handleClearProjectData =')));
  const calls=[];
  let fail=true;
  const context={generatePlanningFromVersions:generate,planning:[],currentWeekId:week,plannerUsername:'Teste',budgetDiffs:[],
    syncPlanningAndPhysical:planning=>({recalculatedPlanning:planning,updatedFloorsData:{}}),allFloorsData:{},cronogramaInicial:[],
    floors:[],history:[],weights:{},teams:[],delayReasons:[],ppcHistory:[],matrices:[],teamPhones:{},projectCity:'',weatherApiKey:'',weatherCache:{},
    saveToDB:async()=>{if(fail)throw new Error('Falha Firebase');calls.push('saved');},
    setPlanning:()=>calls.push('planning'),setAllFloorsData:()=>calls.push('floors'),setBudgetDiffs:()=>calls.push('diffs'),setNotification:()=>calls.push('success')};
  const run=new Function('context',`const {${Object.keys(context).join(',')}}=context;${handler};return handleGeneratePlanningFromBudgetDiffs;`)(context);
  await assert.rejects(()=>run(version('v1',30),version('v3',75)),/Falha Firebase/);
  assert.deepEqual(calls,[]);
  fail=false;await run(version('v1',30),version('v3',75));
  assert.deepEqual(calls,['saved','planning','floors','diffs','success']);
});
