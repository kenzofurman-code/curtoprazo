import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const source=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
const handler=source.slice(source.indexOf('  const handleCompleteScheduleImport ='),source.indexOf('  const handleAddFloor ='));
const code=ts.transpileModule(handler,{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText;
function setup(createVersion) {
  const calls=[],notifications=[];
  const context={
    canOpenModule:()=>true,selectedProjectId:'obra',createNewScheduleVersion:createVersion,
    syncPlanningAndPhysical:()=>({recalculatedPlanning:[],updatedFloorsData:{}}),planning:[],
    history:[],delayReasons:[],ppcHistory:[],teamPhones:{},projectCity:'',weatherApiKey:'',weatherCache:{},
    setFloors:()=>{},setAllFloorsData:()=>{},setWeights:()=>{},setCronogramaInicial:()=>{},setTeams:()=>{},setMatrices:()=>{},setPlanning:()=>{},
    saveToDB:async()=>calls.push('project-saved'),setVersionUpdateKey:()=>calls.push('version-view-updated'),
    setNotification:value=>notifications.push(value),console:{error:()=>{}}
  };
  const complete=new Function('context',`const {${Object.keys(context).join(',')}}=context;${code};return handleCompleteScheduleImport;`)(context);
  return {complete:()=>complete({parsedItems:[{id:'1'}],floors:[],allFloorsData:{},weights:{},teams:[],matrices:[],stats:{totalActivities:1,totalFloors:0}},
    {name:'Importado',description:'',type:'forecast',author:'Teste',referenceDate:'2026-11-03',sourceFileName:'arquivo.xlsx',isBaseline:false,makeActive:true}),calls,notifications};
}
test('importação aguarda persistência do histórico antes de aplicar e indicar sucesso',async()=>{
  let resolve;
  const stored=new Promise(done=>{resolve=done;});
  const run=setup(()=>stored);
  const pending=run.complete();
  assert.deepEqual(run.calls,[]);assert.deepEqual(run.notifications,[]);
  resolve({created:{id:'version1'}});await pending;
  assert.deepEqual(run.calls,['project-saved','version-view-updated']);
  assert.equal(run.notifications.at(-1).type,'success');
});
test('falha de persistência não altera o projeto nem fecha o formulário com falso sucesso',async()=>{
  const run=setup(async()=>{throw new Error('Sem espaço para histórico');});
  await assert.rejects(run.complete,/Sem espaço para histórico/);
  assert.deepEqual(run.calls,[]);
  assert.equal(run.notifications.at(-1).type,'error');
});
