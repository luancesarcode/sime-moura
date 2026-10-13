"""Verifica HTTPS/EasyAuth/API hospedada sem gravar ou imprimir tokens/cookies."""
import argparse,json,subprocess,urllib.request,urllib.error,hashlib,uuid
from pathlib import Path
from datetime import datetime,timezone

def main():
 p=argparse.ArgumentParser();p.add_argument('--az',required=True);p.add_argument('--run',required=True);p.add_argument('--read-only',action='store_true');a=p.parse_args();run=Path(a.run);cfg=json.loads((run/'container-config.json').read_text(encoding='utf8'));url='https://'+cfg['env']['MOURA_ALLOWED_HOSTS']
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args):return None
 client=urllib.request.build_opener(NoRedirect)
 response=subprocess.run([a.az,'account','get-access-token','--resource','api://'+cfg['loginAppId'],'--output','json'],capture_output=True,text=True)
 if response.returncode:raise RuntimeError(response.stderr[-1200:])
 token=json.loads(response.stdout)['accessToken']
 def deployment():
  result=subprocess.run([a.az,'containerapp','show','-g',cfg['resourceGroup'],'-n',cfg['appName'],'--output','json'],capture_output=True,text=True)
  if result.returncode:raise RuntimeError(result.stderr[-1000:])
  props=json.loads(result.stdout)['properties'];image=props['template']['containers'][0]['image'];expected=json.loads((run/'image.json').read_text(encoding='utf8'))['digest']
  assert image==cfg['registryServer']+'/moura-demo@'+expected and props['latestRevisionName']==props['latestReadyRevisionName'] and props['configuration']['activeRevisionsMode']=='Single'
  return {'at':datetime.now(timezone.utc).isoformat(),'imageDigest':expected,'containerAppRevision':props['latestReadyRevisionName'],'activeRevisionsMode':'Single','traffic':props['configuration']['ingress']['traffic']}
 observed=deployment() if a.read_only else None
 def request(path,method='GET',body=None,auth=True,headers=None):
  h={'Authorization':'Bearer '+token} if auth else {};h.update(headers or {})
  data=None
  if body is not None:h['Content-Type']='application/json';data=json.dumps(body).encode()
  req=urllib.request.Request(url+path,data=data,method=method,headers=h)
  try:r=client.open(req,timeout=100)
  except urllib.error.HTTPError as e:r=e
  content=r.read();return r.code,content,{k.lower():v for k,v in r.headers.items()}
 status,_,headers=request('/api/health',auth=False);assert status in [302,401],status
 spoof,_,_=request('/api/state',auth=False,headers={'X-MS-CLIENT-PRINCIPAL-ID':cfg['ownerObjectId']});assert spoof in [302,401],spoof
 code,raw,_=request('/api/health');health=json.loads(raw);assert code==200 and health['mode']=='azure-demo',(code,raw[:300])
 code,raw,_=request('/api/state');assert code==200,(code,raw[:500]);state=json.loads(raw)
 code,data,headers=request('/api/history');assert code==200,(code,data[:300]);expected=Path(__file__).resolve().parent.parent/'data/historico.json';assert data==expected.read_bytes()
 etag=headers.get('etag');assert etag;assert request('/api/history',headers={'If-None-Match':etag})[0]==304
 code,_,_=request('/data/state.json');assert code==404,code
 if a.read_only:
  previous=json.loads((run/'hosted-api.json').read_text(encoding='utf8'));assert any(c['id']==previous['simulatedCallRetained'] for c in state['calls'])
  code,appjs,_=request('/app.js');assert code==200 and appjs==(expected.parent.parent/'public/app.js').read_bytes()
  report={'at':datetime.now(timezone.utc).isoformat(),'url':url,'status':'PASS','mode':'read-only','anonymousStatus':status,'spoofedHeaderStatus':spoof,'ownerHealthStatus':200,'health':health,'stateRevision':state['revision'],'simulatedCallRetained':previous['simulatedCallRetained'],'cloudSqlRead':True,'cloudPrivateBlobRead':True,'historySha256':hashlib.sha256(data).hexdigest(),'historyNotModifiedStatus':304,'privateLocalPathStatus':404,'frontendSha256':hashlib.sha256(appjs).hexdigest(),'writesPerformed':0,'authentication':'token delegado Entra do proprietário via Azure CLI; fluxo visual documentado separadamente'}
  after=deployment();assert after['imageDigest']==observed['imageDigest'] and after['containerAppRevision']==observed['containerAppRevision'];report['deploymentObservedBefore']=observed;report['deploymentObservedAfter']=after
  (run/'hosted-final.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(report,ensure_ascii=False));return
 payload={'machine':'A','subdivision':'AQUECIMENTO','symptom':'Teste técnico do aplicativo hospedado em Azure — simulação','requester':'Luan — verificação técnica','impact':1,'safety':1,'quality':1,'redundancy':True,'expectedRevision':state['revision'],'clientRequestId':str(uuid.uuid4())}
 code,raw,_=request('/api/calls','POST',payload);assert code==201,(code,raw[:400]);created=json.loads(raw)
 repeat,raw,_=request('/api/calls','POST',payload);again=json.loads(raw);assert repeat==200 and again['call']['id']==created['call']['id'] and again['revision']==created['revision']
 code,raw,_=request('/api/state');after=json.loads(raw);assert code==200 and after['revision']==state['revision']+1
 report={'at':datetime.now(timezone.utc).isoformat(),'url':url,'anonymousStatus':status,'spoofedHeaderStatus':spoof,'ownerHealthStatus':200,'health':health,'cloudSqlReadWrite':True,'cloudPrivateBlobRead':True,'historySha256':hashlib.sha256(data).hexdigest(),'historyNotModifiedStatus':304,'privateLocalPathStatus':404,'createdStatus':201,'idempotentRepeatStatus':200,'beforeRevision':state['revision'],'afterRevision':after['revision'],'simulatedCallRetained':created['call']['id'],'authentication':'token delegado Entra do proprietário via Azure CLI; não valida navegação/login interativo do browser'}
 (run/'hosted-api.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':main()
