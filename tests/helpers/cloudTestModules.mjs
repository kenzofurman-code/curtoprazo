import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const compile = source => ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;
const sources = Object.fromEntries(await Promise.all(['chunkedPayload','cloudDocumentRepository','firebaseDocuments'].map(async name => [name,compile(await readFile(new URL(`../../src/${name}.ts`,import.meta.url),'utf8'))])));
const copy = value => value === undefined ? undefined : structuredClone(value);
export function cloudTestModules() {
  const backend = {documents:new Map(),reads:[],writes:[],failRead:false,failWrite:false};
  let queue = Promise.resolve();
  const snapshot = value => ({exists:()=>value!==undefined,data:()=>copy(value)});
  const firestore = {
    doc:(_,path,id)=>({id:id || path.split('/').at(-1)}),
    getDocFromServer:async ref=>{backend.reads.push(ref.id);if(backend.failRead)throw new Error('sem conexão');return snapshot(backend.documents.get(ref.id));},
    runTransaction:(_,operation)=>{
      const current=queue.catch(()=>{}).then(async()=>{
        const pending=new Map();let writing=false;
        const result=await operation({
          get:async ref=>{if(writing)throw new Error('leitura após escrita');backend.reads.push(ref.id);if(backend.failRead)throw new Error('sem conexão');return snapshot(backend.documents.get(ref.id));},
          set:(ref,value)=>{writing=true;pending.set(ref.id,copy(value));}
        });
        if(backend.failWrite)throw new Error('Firebase recusou a gravação');
        for(const [id,value]of pending){backend.documents.set(id,value);backend.writes.push({id,value});}
        return result;
      });
      queue=current;return current;
    }
  };
  const modules={};
  function load(name){
    if(modules[name])return modules[name];
    const module={exports:{}};
    new Function('require','exports','module',sources[name])(id=>{
      if(id==='firebase/firestore')return firestore;
      if(id.startsWith('./'))return load(id.slice(2));
      throw new Error('Unexpected test dependency '+id);
    },module.exports,module);
    modules[name]=module.exports;return module.exports;
  }
  return {backend,client:load('firebaseDocuments'),repository:load('cloudDocumentRepository')};
}
