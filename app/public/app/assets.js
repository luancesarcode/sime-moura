// Stable IDs and display/nature metadata; no business rule depends on A/B/C/D.
export function getAssets(history) {
  const metadata=history?.metadata?.assets;
  const source=Array.isArray(metadata)&&metadata.length?metadata:(history?.metrics?.summaries??[]).map(s=>({id:s.machine,displayName:s.displayName??s.machine,assetNature:s.assetNature,studyFocus:s.studyFocus??s.assetNature==='real anonymized'}));
  const unique=new Map();
  for(const a of source){if(typeof a.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(a.id)||unique.has(a.id))continue;unique.set(a.id,{id:a.id,label:typeof a.displayName==='string'&&a.displayName.trim()?a.displayName.trim():a.id,nature:a.assetNature??'unknown',focus:a.studyFocus===true});}
  return [...unique.values()];
}
export const defaultAssetId=history=>{const assets=getAssets(history);return (assets.find(a=>a.focus)??assets[0])?.id??null;};
export const assetLabel=(history,id)=>getAssets(history).find(a=>a.id===id)?.label??id??'—';
export const assetNatureLabel=(history,id)=>{const nature=getAssets(history).find(a=>a.id===id)?.nature;return nature==='real anonymized'?'ativo real anonimizado':nature==='fictitious'?'ativo fictício':'natureza não informada';};
