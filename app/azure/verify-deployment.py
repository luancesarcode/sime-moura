"""Confere versão/imagem/autenticação por metadados sem imprimir segredos."""
import argparse,json,subprocess,hashlib
from pathlib import Path
from datetime import datetime,timezone
def main():
 p=argparse.ArgumentParser();p.add_argument('--az',required=True);p.add_argument('--run',required=True);a=p.parse_args();run=Path(a.run);site=Path(__file__).resolve().parent.parent
 def az(*args):
  r=subprocess.run([a.az,*args,'--output','json'],capture_output=True,text=True)
  if r.returncode:raise RuntimeError(r.stderr[-1000:])
  return json.loads(r.stdout)
 app=az('containerapp','show','-g','rg-moura-demo','-n','moura-demo');props=app['properties'];image=json.loads((run/'image.json').read_text(encoding='utf8'));cfg=json.loads((run/'container-config.json').read_text(encoding='utf8'))
 template=props['template'];container=template['containers'][0];expected=cfg['registryServer']+'/moura-demo@'+image['digest'];assert container['image']==expected
 assert template['scale']['minReplicas']==0 and template['scale']['maxReplicas']==1 and container['resources']['cpu']==.25 and container['resources']['memory']=='0.5Gi'
 env={e['name']:e.get('value') for e in container['env']};assert all(env[k]==v for k,v in cfg['env'].items());assert cfg['identityResourceId'].lower() in [k.lower() for k in app['identity']['userAssignedIdentities']]
 ingress=props['configuration']['ingress'];assert ingress['external'] is True and ingress['allowInsecure'] is False
 assert props['configuration']['activeRevisionsMode']=='Single' and all(t.get('weight',0)==0 or (t.get('latestRevision') is True and t['weight']==100) for t in ingress['traffic'])
 auth=az('rest','--method','get','--url','https://management.azure.com'+app['id']+'/authConfigs/current?api-version=2025-01-01')['properties']
 aad=auth['identityProviders']['azureActiveDirectory'];assert auth['platform']['enabled'] is True and auth['httpSettings']['requireHttps'] is True and auth['globalValidation']['unauthenticatedClientAction']=='RedirectToLoginPage'
 assert aad['validation']['defaultAuthorizationPolicy']['allowedPrincipals']['identities']==[cfg['ownerObjectId']]
 revision=az('containerapp','revision','show','-g','rg-moura-demo','-n','moura-demo','--revision',props['latestReadyRevisionName'])['properties'];assert revision['healthState']=='Healthy' and props['latestRevisionName']==props['latestReadyRevisionName']
 runtime=[{'path':f['path'],'match':hashlib.sha256((site/f['path']).read_bytes()).hexdigest()==f['sha256']} for f in image['appFiles']];assert all(f['match'] for f in runtime)
 package={'status':'PASS','runtimeFiles':runtime,'ephemeralCredentialsRemoved':not(run/'.acr-auth').exists(),'privateSourcesIncluded':False,'imageDigest':image['digest']};assert package['ephemeralCredentialsRemoved']
 (run/'package-validation.json').write_text(json.dumps(package,indent=2),encoding='utf8')
 report={'status':'PASS','at':datetime.now(timezone.utc).isoformat(),'image':expected,'latestReadyRevision':props['latestReadyRevisionName'],'healthState':revision['healthState'],'activeRevisionsMode':props['configuration']['activeRevisionsMode'],'traffic':ingress['traffic'],'scale':template['scale'],'resources':container['resources'],'envMatches':True,'managedIdentityAttached':True,'httpsOnly':True,'ownerOnlyAuth':True,'fqdn':ingress['fqdn'],'runtimeFilesMatch':True}
 (run/'deployment-final.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':main()
