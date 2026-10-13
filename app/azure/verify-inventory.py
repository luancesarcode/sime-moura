"""Inventário apenas de metadados ARM; não lê segredos de recursos."""
import argparse,json,subprocess
from pathlib import Path
def main():
 p=argparse.ArgumentParser();p.add_argument('--az',required=True);p.add_argument('--run',required=True);a=p.parse_args();run=Path(a.run)
 def az(*args):
  result=subprocess.run([a.az,*args,'--output','json'],capture_output=True,text=True)
  if result.returncode:raise RuntimeError(result.stderr[-1000:])
  return json.loads(result.stdout)
 inventory=[{k:r.get(k) for k in ['name','type','location','resourceGroup']} for r in az('resource','list')]
 account=az('account','show');policy=az('rest','--method','get','--url','https://management.azure.com/subscriptions/'+account['id']+'?api-version=2022-12-01')['subscriptionPolicies']
 sql=az('sql','server','ad-only-auth','get','-g','rg-moura-demo','--name','sql-moura-br-0582a5da')
 firewall=az('sql','server','firewall-rule','list','-g','rg-moura-demo','--server','sql-moura-br-0582a5da')
 assert sql['azureAdOnlyAuthentication'] is True
 assert all(r['startIpAddress']==r['endIpAddress'] and r['startIpAddress']!='0.0.0.0' and r['name'] not in ['luan-migracao-temporaria','container-moura-saida'] for r in firewall)
 types=[r['type'].lower() for r in inventory];assert 'microsoft.web/serverfarms' not in types and 'microsoft.operationalinsights/workspaces' not in types
 report={'status':'PASS','resources':inventory,'subscriptionPolicy':policy,'entraOnly':True,'sqlFirewallRuleCount':len(firewall),'temporaryAdminRuleRemoved':True,'broadAzureRule':False,'appServicePlans':0,'logAnalyticsWorkspaces':0,'creditBalance':'não verificado','creditExpiry':'não verificada'}
 report['additionalResources']=[r for r in inventory if r['type'].lower().startswith('microsoft.cognitiveservices/')]
 report['scopeNote']='PASS dos controles da demonstração; recursos adicionais identificados e preservados. Não apagar o grupo inteiro sem esclarecer esses recursos.'
 (run/'inventory-final.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':main()
