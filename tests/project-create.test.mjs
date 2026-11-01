import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = await readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
const compile = code => ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
function setup(overrides={}) {
  const notifications=[], pending=[], saved=[], closed=[];
  const context={db:{},userId:'test',isAddingProject:false,newProjName:'Obra Nova',newProjArea:'1234.56',newProjAddress:'Rua de teste',
    newProjBadges:'CC, EL',newProjImageUrl:'',projects:[{id:'existente',name:'EXISTENTE'}],appId:'test',
    slugify:value=>value.toLowerCase().replace(/\s+/g,'_'),doc:(_,path,id)=>({path,id}),
    setDoc:async(ref,value)=>saved.push({ref,value}),setProjects:value=>{},setIsAddingProject:value=>pending.push(value),
    setNotification:value=>notifications.push(value),setShowAddProjectModal:value=>closed.push(value),
    setNewProjName:()=>{},setNewProjArea:()=>{},setNewProjAddress:()=>{},setNewProjBadges:()=>{},setNewProjImageUrl:()=>{},
    console:{error:()=>{}},...overrides};
  const handler=source.slice(source.indexOf('  const handleAddNewProject ='),source.indexOf('  const compressAndSetImage ='));
  const submit=new Function('context',`const {${Object.keys(context).join(',')}}=context;${compile(handler)};return handleAddNewProject;`)(context);
  return {submit:()=>submit({preventDefault(){}}),notifications,pending,saved,closed};
}
test('salva novo projeto e preserva os projetos existentes',async()=>{
  const run=setup();await run.submit();
  assert.equal(run.saved[0].ref.id,'all_projects_metadata');
  assert.deepEqual(run.saved[0].value.list[0],{id:'existente',name:'EXISTENTE'});
  assert.equal(run.saved[0].value.list[1].id,'obra_nova');
  assert.equal(run.saved[0].value.list[1].area,'1234.56');
  assert.deepEqual(run.pending,[true,false]);assert.deepEqual(run.closed,[false]);
  assert.equal(run.notifications[0].type,'success');
});
test('nome duplicado e conexão indisponível não gravam nem fecham o formulário',async()=>{
  for(const overrides of [{newProjName:'existente'},{db:null}]) {
    const run=setup(overrides);await run.submit();
    assert.equal(run.saved.length,0);assert.equal(run.closed.length,0);
    assert.equal(run.notifications[0].type,'error');
  }
});
test('falha de permissão libera nova tentativa e conserva o formulário',async()=>{
  const run=setup({setDoc:async()=>{throw {code:'permission-denied'};}});await run.submit();
  assert.deepEqual(run.pending,[true,false]);assert.equal(run.closed.length,0);
  assert.match(run.notifications[0].message,/permissão/);
});
test('mensagem de erro é renderizada no painel mesmo com formulário aberto',()=>{
  const dashboard=source.slice(source.indexOf('  const renderProjectsDashboard ='),source.indexOf('  const renderInfographic ='));
  const context={React,projects:[],projectSearchQuery:'',plannerUsername:'admin',isAccessAdmin:false,
    accessControl:{users:[],projectAccess:{}},showAddProjectModal:true,editingProject:null,showAccessModal:false,
    setShowAccessModal:()=>{},setAccessUser:()=>{},setAccessPass:()=>{},handleAddNewProject:()=>{},
    newProjName:'existente',newProjArea:'1',newProjAddress:'Rua',newProjBadges:'',newProjImageUrl:'',
    setNewProjName:()=>{},setNewProjArea:()=>{},setNewProjAddress:()=>{},setNewProjBadges:()=>{},setNewProjImageUrl:()=>{},
    setShowAddProjectModal:()=>{},handleAddImageFileChange:()=>{},isAddingProject:false,
    notification:{message:'Um projeto com esse nome já existe.',type:'error'},setNotification:()=>{},
    Notification:({message})=>React.createElement('div',{role:'alert'},message)};
  const render=new Function('context',`const {${Object.keys(context).join(',')}}=context;${compile(dashboard)};return renderProjectsDashboard;`)(context);
  const html=renderToStaticMarkup(render());
  assert.match(html,/role="alert"/);assert.match(html,/Um projeto com esse nome já existe/);assert.match(html,/Salvar Projeto/);
});
