"""Atualiza imagem/configuração, ativa EasyAuth e só então expõe ingresso HTTPS.
Os segredos são obtidos em memória, gravados em JSON efêmero e nunca impressos.
"""
import argparse,json,os,subprocess
from datetime import datetime,timedelta,timezone
from pathlib import Path

def main():
 p=argparse.ArgumentParser();p.add_argument('--az',required=True);p.add_argument('--run',required=True);p.add_argument('--existing',action='store_true');a=p.parse_args();run=Path(a.run).resolve();config=json.loads((run/'container-config.json').read_text(encoding='utf8'))
 def az(*args,json_result=False):
  r=subprocess.run([a.az,*args,'--output','json' if json_result else 'none'],capture_output=True,text=True,encoding='utf8',errors='replace')
  if r.returncode:raise RuntimeError('Operação Azure falhou: '+r.stderr[-2000:])
  return json.loads(r.stdout) if json_result else None
 group=config['resourceGroup'];name=config['appName'];image=json.loads((run/'image.json').read_text(encoding='utf8'));digest=image['image'].split(':')[0]+'@'+image['digest'];identity=config['identityResourceId']
 if a.existing:app=az('containerapp','show','--resource-group',group,'--name',name,json_result=True)
 else:app=az('containerapp','create','--resource-group',group,'--name',name,'--environment',config['environment'],
  '--image',digest,'--registry-server',config['registryServer'],'--registry-identity',identity,'--user-assigned',identity,
  '--cpu','0.25','--memory','0.5Gi','--min-replicas','0','--max-replicas','1','--ingress','internal','--target-port','8080','--transport','http',
  '--env-vars',*[k+'='+v for k,v in config['env'].items()],json_result=True)
 # Egress compartilhado pode mudar após escala/reinício. Regras /32 para a lista
 # anunciada pelo próprio recurso; nenhum 0.0.0.0/Allow Azure Services. Entra-only
 # e autorização da identidade permanecem obrigatórios no SQL. Para produção,
 # substituir por VNet/saída fixa e endpoints privados conforme ambiente da empresa.
 ips=app['properties'].get('outboundIpAddresses',[])
 if not ips or len(ips)>240:raise RuntimeError('Lista egress vazia ou acima do limite previsto de firewall SQL.')
 template={'$schema':'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#','contentVersion':'1.0.0.0',
  'parameters':{'outboundIps':{'type':'array','defaultValue':ips},'sqlServer':{'type':'string','defaultValue':config['sqlServerName']}},
  'resources':[{'type':'Microsoft.Sql/servers/firewallRules','apiVersion':'2023-08-01',
   'name':"[concat(parameters('sqlServer'),'/moura-container-',copyIndex())]",'copy':{'name':'MouraContainerEgress','count':"[length(parameters('outboundIps'))]",'mode':'parallel'},
   'properties':{'startIpAddress':"[parameters('outboundIps')[copyIndex()]]",'endIpAddress':"[parameters('outboundIps')[copyIndex()]]"}}]}
 firewallfile=run/'firewall-template.json';firewallfile.write_text(json.dumps(template),encoding='utf8')
 az('deployment','group','create','--resource-group',group,'--name','moura-firewall-egress','--template-file',str(firewallfile))
 expires=(datetime.now(timezone.utc)+timedelta(days=31)).strftime('%Y-%m-%dT%H:%M:%SZ')
 existing=az('containerapp','secret','list','--resource-group',group,'--name',name,json_result=True)
 if not any(s['name']=='microsoft-login' for s in existing):
  secret=az('ad','app','credential','reset','--id',config['loginAppId'],'--append','--display-name','Container Apps demonstração 31 dias','--end-date',expires,json_result=True)['password']
  az('containerapp','secret','set','--resource-group',group,'--name',name,'--secrets','microsoft-login='+secret)
 authfile=run/'auth-request.json';base=f'https://management.azure.com/subscriptions/{config["subscription"]}/resourceGroups/{group}/providers/Microsoft.App/containerApps/{name}'
 auth={'properties':{'platform':{'enabled':True},'globalValidation':{'unauthenticatedClientAction':'RedirectToLoginPage','redirectToProvider':'azureActiveDirectory'},
  'identityProviders':{'azureActiveDirectory':{'enabled':True,'registration':{'clientId':config['loginAppId'],'clientSecretSettingName':'microsoft-login','openIdIssuer':f'https://login.microsoftonline.com/{config["tenant"]}/v2.0'},
    'validation':{'allowedAudiences':[config['loginAppId'],'api://'+config['loginAppId']],'defaultAuthorizationPolicy':{'allowedPrincipals':{'identities':[config['ownerObjectId']]}}}}},
  'httpSettings':{'requireHttps':True},'login':{'tokenStore':{'enabled':False}}}}
 authfile.write_text(json.dumps(auth,indent=2),encoding='utf8')
 az('rest','--method','put','--url',base+'/authConfigs/current?api-version=2025-01-01','--body','@'+str(authfile))
 # Não abre ingresso se a configuração de autenticação não estiver persistida.
 observed=az('rest','--method','get','--url',base+'/authConfigs/current?api-version=2025-01-01',json_result=True)['properties']
 assert observed['platform']['enabled'] and observed['globalValidation']['unauthenticatedClientAction']=='RedirectToLoginPage'
 assert observed['identityProviders']['azureActiveDirectory']['registration']['clientId']==config['loginAppId']
 assert observed['identityProviders']['azureActiveDirectory']['validation']['defaultAuthorizationPolicy']['allowedPrincipals']['identities']==[config['ownerObjectId']]
 assert observed['httpSettings']['requireHttps'] and not observed['globalValidation'].get('excludedPaths')
 az('containerapp','ingress','enable','--resource-group',group,'--name',name,'--type','external','--target-port','8080','--transport','http')
 current=az('containerapp','show','--resource-group',group,'--name',name,json_result=True)
 expectedHost=config['env']['MOURA_ALLOWED_HOSTS'];assert current['properties']['configuration']['ingress']['fqdn']==expectedHost
 report={'at':datetime.now(timezone.utc).isoformat(),'name':name,'host':expectedHost,'image':digest,'provisioningState':current['properties']['provisioningState'],'latestRevision':current['properties'].get('latestRevisionName'),
  'identity':current['identity'],'ingress':current['properties']['configuration']['ingress'],'scale':current['properties']['template']['scale'],'workloadProfileName':current['properties'].get('workloadProfileName'),'authentication':observed,'loginSecretExpiry':expires,'outboundIpAddresses':current['properties'].get('outboundIpAddresses',[])}
 (run/'deployment.json').write_text(json.dumps(report,indent=2),encoding='utf8');print(json.dumps({'host':expectedHost,'provisioningState':report['provisioningState'],'revision':report['latestRevision']}))

if __name__=='__main__':main()
