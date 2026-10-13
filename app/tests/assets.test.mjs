import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getAssets,defaultAssetId,assetLabel,assetNatureLabel } from '../public/app/assets.js';
import { makeCall,priority } from '../scripts/domain.mjs';
const original=JSON.parse(await readFile(new URL('../data/historico.json',import.meta.url),'utf8'));
test('catálogo renomeado conserva natureza, foco, vínculo e prioridade sem letras especiais',()=>{
  const history=structuredClone(original),mapping={A:'unit_01',B:'unit_02',C:'unit_03',D:'unit_04'};
  history.metadata.assets=original.metrics.summaries.map(s=>({id:mapping[s.machine],displayName:`Unidade ${mapping[s.machine]}`,assetNature:s.assetNature,studyFocus:s.assetNature==='real anonymized'}));
  for(const r of history.mes)r.machine=mapping[r.machine];for(const s of history.metrics.summaries)s.machine=mapping[s.machine];
  assert.equal(defaultAssetId(history),'unit_01');assert.equal(getAssets(history).length,4);assert.equal(assetLabel(history,'unit_02'),'Unidade unit_02');assert.equal(assetNatureLabel(history,'unit_01'),'ativo real anonimizado');assert.equal(assetNatureLabel(history,'unit_02'),'ativo fictício');
  const body={machine:'unit_01',subdivision:'teste',symptom:'Condição simulada',requester:'Demonstração',impact:4,safety:2,quality:1,redundancy:false,linkedMesId:history.mes.find(r=>r.machine==='unit_01').id};
  const renamed=makeCall(body,history,'2026-10-09T12:00:00Z'),old=makeCall({...body,machine:'A'},original,'2026-10-09T12:00:00Z');
  assert.deepEqual(priority(renamed),priority(old));assert.equal(renamed.machine,'unit_01');assert.equal(renamed.linkedMesId,old.linkedMesId);
  assert.throws(()=>makeCall({...body,machine:'A'},history),/Ativo inválido/);
});
test('catálogo rejeita IDs inseguros e duplicados sem presumir natureza',()=>{
  const h={metadata:{assets:[{id:'<script>'},{id:'machine-77',displayName:'Prensa'},{id:'machine-77',displayName:'Duplicata'},{id:'focus',studyFocus:true,assetNature:'fictitious'}]}};
  assert.equal(getAssets(h).length,2);assert.equal(defaultAssetId(h),'focus');assert.equal(assetNatureLabel(h,'machine-77'),'natureza não informada');assert.equal(assetLabel(h,'machine-77'),'Prensa');
});
